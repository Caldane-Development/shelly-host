import { Device, IDevice } from "../../../common/models/device.interface";
import { createMqttConfig } from "./mqtt.helper";
import roomList from "../assets/json/room-list.json";
import { db } from "../db/client";
import { devices as devicesTable } from "../db/schema";
import { logger } from "../logger";
import { sql } from "drizzle-orm";

const slugify = (text: string): string => text.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();

const messageUrlPattern = /\/api\/message\/srd\/[^/]+\/(\d+)\/([^/]+)\/switch\/message\/toggle\/[^/?#]+/i;
const groupUrlPattern = /\/api\/group\/\d+\/trigger/i;

const hasLinkedActions = (device: IDevice): boolean => {
    const hooks = device.webhooks?.result?.hooks ?? [];
    if (!hooks.length) {
        return false;
    }

    const sourceSlug = slugify(device.name || "");
    const sourceRoomId = Number(device.room?.id ?? device.device?.room_id ?? -1);

    for (const hook of hooks) {
        for (const url of hook.urls ?? []) {
            if (groupUrlPattern.test(url)) {
                return true;
            }

            const match = messageUrlPattern.exec(url);
            if (!match) {
                continue;
            }

            const targetRoomId = Number(match[1]);
            const targetSlug = slugify(match[2] || "");
            if (targetSlug !== sourceSlug || targetRoomId !== sourceRoomId) {
                return true;
            }
        }
    }

    return false;
};

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

const toDeviceRow = (device: Device, mqtt?: IDevice["mqtt"]) => ({
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
    mqttEnable: Boolean(mqtt?.enable),
    mqttServer: mqtt?.server || "",
    mqttTopic: mqtt?.topic_prefix || "",
    linked: false,
});

export const saveDiscoveredDevices = async (discovered: IDevice[]): Promise<void> => {
    const rows = discovered
        .filter((d) => d?.device && d.device.id !== undefined && d.device.id !== null)
        .map((d) => ({
            ...toDeviceRow(d.device, d.mqtt),
            linked: hasLinkedActions(d),
        }));

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
                    mqttEnable: sql`excluded.mqtt_enable`,
                    mqttServer: sql`excluded.mqtt_server`,
                    mqttTopic: sql`excluded.mqtt_topic`,
                    linked: sql`excluded.linked`,
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

type StoredDeviceRow = Awaited<ReturnType<typeof getStoredDevices>>[number];

// Map a persisted (camelCase, drizzle) row back to the device-list Device shape
// so it can be enriched into a full IDevice.
const toDevice = (row: StoredDeviceRow): Device => ({
    id: row.id,
    type: row.type,
    category: row.category,
    position: row.position,
    gen: row.gen,
    channel: row.channel,
    channels_count: row.channelsCount,
    mode: row.mode,
    name: row.name,
    room_id: row.roomId,
    image: row.image,
    cloud_options: row.cloudOptions as Device["cloud_options"],
    cloud_online: row.cloudOnline,
    modified: row.modified ? Math.floor(row.modified.getTime() / 1000) : 0,
    ip: row.ip,
    ssid: row.ssid,
});

// Return stored devices enriched into full IDevice objects (with MQTT config and
// room details) so the client can render interactive Shelly cards.
export const getStoredIDevices = async (): Promise<IDevice[]> => {
    const rows = await getStoredDevices();

    // createMqttConfig fabricates enable/connected=true. Override with the real
    // MQTT state that was persisted during the last scan so cards reflect the
    // actual connection status.
    return rows.map((row) => {
        const device = createIDevice(toDevice(row));
        const enable = Boolean(row.mqttEnable);
        return {
            ...device,
            linked: Boolean(row.linked),
            mqtt: {
                ...device.mqtt,
                enable,
                connected: enable,
                // Only expose a broker when MQTT is actually configured; the
                // fabricated default from createMqttConfig would otherwise make
                // unconfigured devices look connected.
                server: enable ? row.mqttServer || device.mqtt.server : "",
                topic_prefix: enable ? row.mqttTopic || device.mqtt.topic_prefix : "",
            },
        };
    });
};

// Return the raw Device records for stored devices that have MQTT enabled, so
// their live switch status can be requested over MQTT.
export const getEnabledDevices = async (): Promise<Device[]> => {
    const rows = await getStoredDevices();
    return rows.filter((row) => row.mqttEnable).map(toDevice);
};
