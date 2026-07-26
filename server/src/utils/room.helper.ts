import { sql } from "drizzle-orm";
import { IDevice } from "../../../common/models/device.interface";
import { db } from "../db/client";
import { rooms as roomsTable } from "../db/schema";
import { logger } from "../logger";

// The room object attached to discovered devices, sourced from room-list.json.
// The shared IDevice.room type is intentionally loose, so describe the fields
// we actually persist here.
interface DiscoveredRoom {
    id: number;
    name: string;
    image?: string;
    backgroundColor?: string;
    main_sensor?: boolean;
    overview_style?: boolean;
    position?: number;
    modified?: number;
}

const toRoomRow = (room: DiscoveredRoom) => ({
    id: room.id,
    name: room.name,
    image: room.image || "",
    backgroundColor: room.backgroundColor || "",
    mainSensor: Boolean(room.main_sensor),
    overviewStyle: Boolean(room.overview_style),
    position: room.position ?? 0,
    modified: new Date((room.modified || 0) * 1000),
});

// Persist the rooms referenced by the devices found during a scan. Rooms are
// upserted so re-scanning refreshes their details without creating duplicates.
export const saveDiscoveredRooms = async (discovered: IDevice[]): Promise<void> => {
    const roomsById = new Map<number, DiscoveredRoom>();
    for (const device of discovered) {
        const room = device?.room as DiscoveredRoom | undefined | null;
        if (room && room.id !== undefined && room.id !== null) {
            roomsById.set(room.id, room);
        }
    }

    const rows = [...roomsById.values()].map(toRoomRow);
    if (rows.length === 0) {
        return;
    }

    try {
        await db
            .insert(roomsTable)
            .values(rows)
            .onConflictDoUpdate({
                target: roomsTable.id,
                set: {
                    name: sql`excluded.name`,
                    image: sql`excluded.image`,
                    backgroundColor: sql`excluded.background_color`,
                    mainSensor: sql`excluded.main_sensor`,
                    overviewStyle: sql`excluded.overview_style`,
                    position: sql`excluded.position`,
                    modified: sql`excluded.modified`,
                },
            });
        logger.info(`[server]: Saved ${rows.length} room(s) to the database`);
    } catch (error) {
        logger.error(`[server]: Failed to save rooms: ${error}`);
    }
};

// Return all stored rooms ordered by their configured display position.
export const getStoredRooms = async () => {
    return db.select().from(roomsTable).orderBy(roomsTable.position);
};
