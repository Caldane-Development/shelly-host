import { Device, IDevice } from "../../../common/models/device.interface";
import { createMqttConfig } from "./mqtt.helper";
import roomList from "../assets/json/room-list.json";
import { db } from "../db/client";
import { devices as devicesTable, switchGroups } from "../db/schema";
import { logger } from "../logger";
import { eq, sql } from "drizzle-orm";

const slugify = (text: string): string => text.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();

const messageUrlPattern = /\/api\/message\/srd\/[^/]+\/(\d+)\/([^/]+)\/switch\/message\/toggle\/[^/?#]+/i;
const groupUrlPattern = /\/api\/group\/\d+\/trigger/i;

const extractLinkedTargets = (
    device: IDevice,
    sourceSlug: string,
    groupNameById: Map<number, string>,
    controllerGroupNames: string[]
): string[] => {
    const details = new Set<string>();
    controllerGroupNames.forEach((name) => details.add(`Group: ${name}`));

    const hooks = device.webhooks?.result?.hooks ?? [];
    for (const hook of hooks) {
        for (const url of hook.urls ?? []) {
            const groupMatch = url.match(/\/api\/group\/(\d+)\/trigger/i);
            if (groupMatch) {
                const groupId = Number(groupMatch[1]);
                const groupName = groupNameById.get(groupId);
                details.add(groupName ? `Group: ${groupName}` : `Group ID: ${groupId}`);
                continue;
            }

            const messageMatch = messageUrlPattern.exec(url);
            if (!messageMatch) {
                continue;
            }

            const targetSlug = slugify(messageMatch[2] || "");
            if (targetSlug && targetSlug !== sourceSlug) {
                details.add(`Device: ${targetSlug}`);
            }
        }
    }

    return [...details].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
};

const extractLinkedTargetsByInput = (device: IDevice, sourceSlug: string, groupNameById: Map<number, string>) => {
    const byInput = new Map<number, Set<string>>();
    const hooks = device.webhooks?.result?.hooks ?? [];

    for (const hook of hooks) {
        const inputId = Number.isInteger(hook.cid) && Number(hook.cid) >= 0 ? Number(hook.cid) : 0;
        const details = byInput.get(inputId) ?? new Set<string>();

        for (const url of hook.urls ?? []) {
            const groupMatch = url.match(/\/api\/group\/(\d+)\/trigger/i);
            if (groupMatch) {
                const groupId = Number(groupMatch[1]);
                const groupName = groupNameById.get(groupId);
                details.add(groupName ? `Group: ${groupName}` : `Group ID: ${groupId}`);
                continue;
            }

            const messageMatch = messageUrlPattern.exec(url);
            if (!messageMatch) {
                continue;
            }

            const targetSlug = slugify(messageMatch[2] || "");
            if (targetSlug && targetSlug !== sourceSlug) {
                details.add(`Device: ${targetSlug}`);
            }
        }

        if (details.size > 0) {
            byInput.set(inputId, details);
        }
    }

    const linkedInputTargets: Record<string, string[]> = {};
    byInput.forEach((values, inputId) => {
        linkedInputTargets[String(inputId)] = [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    });

    return linkedInputTargets;
};

const hasLinkedActions = (device: IDevice): boolean => {
    const hooks = device.webhooks?.result?.hooks ?? [];
    if (!hooks.length) {
        return false;
    }

    const sourceSlug = slugify(device.name || "");

    for (const hook of hooks) {
        for (const url of hook.urls ?? []) {
            if (groupUrlPattern.test(url)) {
                return true;
            }

            const match = messageUrlPattern.exec(url);
            if (!match) {
                continue;
            }

            const targetSlug = slugify(match[2] || "");
            // Room IDs in legacy webhook URLs can drift while still targeting
            // the same logical device slug. Only treat as linked when the
            // target device slug differs from the source device slug.
            if (targetSlug !== sourceSlug) {
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

const toDeviceRow = (device: Device, mqtt?: IDevice["mqtt"], linkedTargets: string[] = [], linkedInputTargets: Record<string, string[]> = {}) => ({
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
    linkedTargets: linkedTargets.join("; "),
    linkedInputTargets: JSON.stringify(linkedInputTargets),
});

export const saveDiscoveredDevices = async (discovered: IDevice[]): Promise<void> => {
    const groups = await db
        .select({ id: switchGroups.id, name: switchGroups.name, controllerDeviceId: switchGroups.controllerDeviceId })
        .from(switchGroups);
    const controllerIds = new Set(
        groups
            .map((group) => group.controllerDeviceId)
            .filter((id): id is string => Boolean(id && id.trim() !== ""))
    );
    const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
    const groupNamesByControllerId = new Map<string, string[]>();

    groups.forEach((group) => {
        if (!group.controllerDeviceId) {
            return;
        }
        const key = group.controllerDeviceId;
        const names = groupNamesByControllerId.get(key) ?? [];
        names.push(group.name);
        groupNamesByControllerId.set(key, names);
    });

    const rows = discovered
        .filter((d) => d?.device && d.device.id !== undefined && d.device.id !== null)
        .map((d) => {
            const deviceId = String(d.device.id);
            const sourceSlug = slugify(d.name || d.device.name || "");
            const controllerGroupNames = (groupNamesByControllerId.get(deviceId) ?? []).sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: "base" })
            );
            const linkedTargets = extractLinkedTargets(d, sourceSlug, groupNameById, controllerGroupNames);
            const linkedInputTargets = extractLinkedTargetsByInput(d, sourceSlug, groupNameById);
            return {
                ...toDeviceRow(d.device, d.mqtt, linkedTargets, linkedInputTargets),
                linked: linkedTargets.length > 0 || hasLinkedActions(d) || controllerIds.has(deviceId),
            };
        });

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
                    linkedTargets: sql`excluded.linked_targets`,
                    linkedInputTargets: sql`excluded.linked_input_targets`,
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
            linkedTargets: row.linkedTargets
                ? row.linkedTargets.split(";").map((entry) => entry.trim()).filter((entry) => entry !== "")
                : [],
            linkedInputTargets: (() => {
                if (!row.linkedInputTargets) {
                    return {};
                }
                try {
                    const parsed = JSON.parse(row.linkedInputTargets) as Record<string, string[]>;
                    return parsed && typeof parsed === "object" ? parsed : {};
                } catch {
                    return {};
                }
            })(),
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

export const updateStoredDeviceRoom = async (deviceId: string, roomId: number): Promise<boolean> => {
    try {
        const updated = await db
            .update(devicesTable)
            .set({ roomId, modified: new Date() })
            .where(eq(devicesTable.id, deviceId))
            .returning({ id: devicesTable.id });

        return updated.length > 0;
    } catch (error) {
        logger.error(`[server]: Failed to update device room (${deviceId} -> ${roomId}): ${error}`);
        return false;
    }
};
