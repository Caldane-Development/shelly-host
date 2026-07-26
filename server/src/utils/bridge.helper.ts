import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { switchBridges, devices as devicesTable } from "../db/schema";
import { logger } from "../logger";

export interface SwitchBridge {
    id: number;
    controllerDeviceId: string;
    controllerChannel: number;
    targetDeviceId: string;
    targetChannel: number;
}

interface EnrichedBridge extends SwitchBridge {
    targetTopicPrefix: string;
    targetName: string;
    controllerName: string;
}

export interface BridgeTarget {
    topicPrefix: string;
    channel: number;
    on: boolean;
    targetName: string;
}

// In-memory cache so the hot MQTT message path never touches the DB.
let cache: EnrichedBridge[] = [];

// Normalize a Shelly `src` (e.g. "shelly1minig3-54320464f030") to the bare
// device id used as the primary key in the devices table.
export const srcToDeviceId = (src: string): string => {
    const parts = src.split("-");
    return (parts[parts.length - 1] || src).toLocaleLowerCase();
};

export const loadBridges = async (): Promise<void> => {
    try {
        const rows = await db
            .select({
                id: switchBridges.id,
                controllerDeviceId: switchBridges.controllerDeviceId,
                controllerChannel: switchBridges.controllerChannel,
                targetDeviceId: switchBridges.targetDeviceId,
                targetChannel: switchBridges.targetChannel,
                targetTopicPrefix: devicesTable.mqttTopic,
                targetName: devicesTable.name,
            })
            .from(switchBridges)
            .leftJoin(devicesTable, eq(switchBridges.targetDeviceId, devicesTable.id));

        const controllers = await db
            .select({ id: devicesTable.id, name: devicesTable.name })
            .from(devicesTable);
        const nameById = new Map(controllers.map((row) => [row.id, row.name]));

        cache = rows.map((row) => ({
            id: row.id,
            controllerDeviceId: row.controllerDeviceId.toLocaleLowerCase(),
            controllerChannel: row.controllerChannel,
            targetDeviceId: row.targetDeviceId.toLocaleLowerCase(),
            targetChannel: row.targetChannel,
            targetTopicPrefix: row.targetTopicPrefix || "",
            targetName: row.targetName || row.targetDeviceId,
            controllerName: nameById.get(row.controllerDeviceId) || row.controllerDeviceId,
        }));
        logger.info(`[server]: Loaded ${cache.length} switch bridge(s) into cache`);
    } catch (error) {
        logger.error(`[server]: Failed to load switch bridges: ${error}`);
    }
};

// Given a controller state change, return the MQTT commands to mirror it onto
// the linked target device(s). Pure/sync so the MQTT handler stays fast.
export const resolveBridgeTargets = (
    controllerSrc: string,
    channel: number,
    output: boolean
): BridgeTarget[] => {
    const controllerId = srcToDeviceId(controllerSrc);
    return cache
        .filter((bridge) => bridge.controllerDeviceId === controllerId && bridge.controllerChannel === channel)
        .filter((bridge) => bridge.targetTopicPrefix !== "")
        .map((bridge) => ({
            topicPrefix: bridge.targetTopicPrefix,
            channel: bridge.targetChannel,
            on: output,
            targetName: bridge.targetName,
        }));
};

export const getBridges = async (): Promise<EnrichedBridge[]> => {
    await loadBridges();
    return cache;
};

export const createBridge = async (
    controllerDeviceId: string,
    targetDeviceId: string,
    controllerChannel = 0,
    targetChannel = 0
): Promise<SwitchBridge> => {
    const [row] = await db
        .insert(switchBridges)
        .values({
            controllerDeviceId: controllerDeviceId.toLocaleLowerCase(),
            controllerChannel,
            targetDeviceId: targetDeviceId.toLocaleLowerCase(),
            targetChannel,
            modified: new Date(),
        })
        .returning();
    await loadBridges();
    return row;
};

export const deleteBridge = async (id: number): Promise<void> => {
    await db.delete(switchBridges).where(eq(switchBridges.id, id));
    await loadBridges();
};
