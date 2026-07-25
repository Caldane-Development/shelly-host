import { Device, IDevice } from "../../../common/models/device.interface";
import { createMqttConfig } from "./mqtt.helper";
import roomList from "../assets/json/room-list.json";
import { db } from "../db/client";
import { devices as devicesTable } from "../db/schema";
import { logger } from "../logger";
import { sql } from "drizzle-orm";

export const createIDevice = (device: Device): IDevice => {
    const room = roomList.data.rooms[device.room_id.toString() as keyof typeof roomList.data.rooms];
    return {
        ip: device.ip,
        name: device.name,
        type: device.type,
        channel: "",
        mqtt: createMqttConfig(device.name, room),
        room: room,
        switchStatus: {
            id: 0,
            source: "mqtt",
            output: false,
            temperature: {
                tC: 0,
                tF: 0,
            }
        },
        device: device,
    } as IDevice;
};

const toDeviceRow = (device: Device) => ({
    id: device.id.toString(),
    type: device.type,
    category: device.category,
    position: device.position,
    gen: device.gen,
    channel: device.channel,
    channelsCount: device.channels_count,
    mode: device.mode,
    name: device.name,
    roomId: device.room_id,
    image: device.image,
    cloudOptions: device.cloud_options,
    cloudOnline: device.cloud_online ?? false,
    modified: new Date((device.modified || 0) * 1000),
    ip: device.ip,
    ssid: device.ssid,
});

export const saveDiscoveredDevices = async (discovered: IDevice[]): Promise<void> => {
    const rows = discovered
        .filter((d) => d?.device && d.device.id !== undefined && d.device.id !== null)
        .map((d) => toDeviceRow(d.device));

    if (rows.length === 0) {
        return;
    }

    try {
        await db
            .insert(devicesTable)
            .values(rows)
            .onConflictDoUpdate({
                target: devicesTable.id,
                set: {
                    type: sql`excluded.type`,
                    category: sql`excluded.category`,
                    position: sql`excluded.position`,
                    gen: sql`excluded.gen`,
                    channel: sql`excluded.channel`,
                    channelsCount: sql`excluded.channels_count`,
                    mode: sql`excluded.mode`,
                    name: sql`excluded.name`,
                    roomId: sql`excluded.room_id`,
                    image: sql`excluded.image`,
                    cloudOptions: sql`excluded.cloud_options`,
                    cloudOnline: sql`excluded.cloud_online`,
                    modified: sql`excluded.modified`,
                    ip: sql`excluded.ip`,
                    ssid: sql`excluded.ssid`,
                },
            });
        logger.info(`[server]: Saved ${rows.length} discovered device(s) to the database`);
    } catch (error) {
        logger.error(`[server]: Failed to save discovered devices: ${error}`);
    }
};

export const getStoredDevices = async () => {
    return db.select().from(devicesTable);
};
