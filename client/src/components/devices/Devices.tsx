import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import style from "./devices.module.css";
import { BACKEND_URL } from "../../constants/env";
import { IDevice } from "../../../../common/models/device.interface";
import ShellyEntity, { DeviceGroup } from "../shelly-entity/ShellyEntity";

// How often to re-poll live switch status so cards self-correct when devices
// change state or come back online at a new IP after a WiFi migration.
const STATUS_POLL_MS = 10000;

const slugify = (text: string) => text.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();
const linkMessagePattern = /\/api\/message\/srd\/[^/]+\/(\d+)\/([^/]+)\/switch\/message\/toggle\/[^/?#]+/i;

const isPlusI4 = (device: IDevice) =>
    device.device?.category === "inputs_reader" && Math.max(1, Number(device.device?.channels_count) || 1) === 4;

interface DeviceTile {
    device: IDevice;
    displayName: string;
    inputIndex?: number;
    lockInputSelection?: boolean;
    linkedPowerStatus?: boolean;
}

interface LinkedTargetRef {
    slug: string;
    roomId?: string;
}

// Devices that share an MQTT topic represent a single logical switch (e.g. a
// 3-way pairing). The "owner" is the device whose name matches the device slug
// embedded in the topic (`{site}/{room}/{device-slug}/switch`); its state is
// mirrored onto the other members so every card shows the same power state.
const mirrorSharedTopics = (devices: IDevice[]): IDevice[] => {
    const ownerOutputByTopic = new Map<string, boolean>();
    devices.forEach((device) => {
        const topic = device.mqtt?.topic_prefix;
        if (!topic) {
            return;
        }
        const deviceSlug = topic.split("/")[2] ?? "";
        if (slugify(device.name) === deviceSlug) {
            ownerOutputByTopic.set(topic, Boolean(device.switchStatus?.output));
        }
    });

    if (ownerOutputByTopic.size === 0) {
        return devices;
    }

    return devices.map((device) => {
        const topic = device.mqtt?.topic_prefix;
        if (topic && ownerOutputByTopic.has(topic)) {
            return { ...device, switchStatus: { ...device.switchStatus, output: ownerOutputByTopic.get(topic)! } };
        }
        return device;
    });
};

const Devices = () => {
    const navigate = useNavigate();
    const [devices, setDevices] = useState<IDevice[]>([]);
    const [groups, setGroups] = useState<DeviceGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const buildTiles = useCallback((list: IDevice[]): DeviceTile[] => {
        const outputBySlug = new Map<string, boolean>();
        const outputByRoomAndSlug = new Map<string, boolean>();
        list.forEach((device) => {
            const slug = slugify(device.name || "");
            const roomId = device.room?.id != null ? String(device.room.id) : undefined;
            outputBySlug.set(slug, Boolean(device.switchStatus?.output));
            if (roomId) {
                outputByRoomAndSlug.set(`${roomId}:${slug}`, Boolean(device.switchStatus?.output));
            }
        });

        const collectWebhookDeviceTargets = (device: IDevice, inputIndex?: number): LinkedTargetRef[] => {
            const targets = new Map<string, LinkedTargetRef>();
            const hooks = device.webhooks?.result?.hooks ?? [];
            const sourceSlug = slugify(device.name || "");

            hooks.forEach((hook) => {
                if (inputIndex !== undefined && Number(hook.cid ?? 0) !== inputIndex) {
                    return;
                }
                (hook.urls ?? []).forEach((url) => {
                    const match = linkMessagePattern.exec(url);
                    if (!match) {
                        return;
                    }
                    const targetRoomId = match[1] || undefined;
                    const targetSlug = slugify(match[2] || "");
                    if (targetSlug && targetSlug !== sourceSlug) {
                        const key = targetRoomId ? `${targetRoomId}:${targetSlug}` : targetSlug;
                        targets.set(key, { slug: targetSlug, roomId: targetRoomId });
                    }
                });
            });

            return [...targets.values()];
        };

        const resolveLinkedPowerStatus = (device: IDevice, inputIndex?: number): boolean | undefined => {
            const persistedTargets = inputIndex !== undefined
                ? device.linkedInputTargets?.[String(inputIndex)] ?? []
                : device.linkedTargets ?? [];

            const persistedDeviceTargets: LinkedTargetRef[] = persistedTargets
                .filter((entry) => entry.toLowerCase().startsWith("device:"))
                .map((entry) => ({ slug: slugify(entry.split(":").slice(1).join(":").trim()) }));

            const webhookTargets = collectWebhookDeviceTargets(device, inputIndex);
            const targetCandidates = new Map<string, LinkedTargetRef>();
            [...persistedDeviceTargets, ...webhookTargets].forEach((target) => {
                if (!target.slug) {
                    return;
                }
                const key = target.roomId ? `${target.roomId}:${target.slug}` : target.slug;
                targetCandidates.set(key, target);
            });

            if (targetCandidates.size !== 1) {
                return undefined;
            }

            const [target] = [...targetCandidates.values()];
            if (target.roomId) {
                return outputByRoomAndSlug.get(`${target.roomId}:${target.slug}`);
            }
            return outputBySlug.get(target.slug);
        };

        const sorted = [...list].sort((a, b) =>
            (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" }) !== 0
                ? (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" })
                : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );

        const tiles: DeviceTile[] = [];
        sorted.forEach((device) => {
            if (!isPlusI4(device)) {
                tiles.push({
                    device,
                    displayName: device.name,
                    linkedPowerStatus: resolveLinkedPowerStatus(device),
                });
                return;
            }

            for (let inputIndex = 0; inputIndex < 4; inputIndex++) {
                tiles.push({
                    device,
                    displayName: `${device.name} (${inputIndex})`,
                    inputIndex,
                    lockInputSelection: true,
                    linkedPowerStatus: resolveLinkedPowerStatus(device, inputIndex),
                });
            }
        });

        return tiles;
    }, []);

    // Load switch groups so each card can show its memberships / controlled
    // groups. Refreshed when a card assigns a controller.
    const fetchGroups = useCallback(async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/group`);
            setGroups(response.ok ? await response.json() : []);
        } catch (err) {
            console.error("Failed to fetch groups", err);
        }
    }, []);

    const handleDeviceUpdated = useCallback((updated: IDevice) => {
        setDevices((prev) =>
            prev.map((device) => {
                const sameId = updated.device?.id !== undefined && device.device?.id === updated.device?.id;
                const sameIp = updated.ip && device.ip === updated.ip;
                if (!sameId && !sameIp) {
                    return device;
                }

                // Preserve the latest known live relay output from the list,
                // but update config fields (MQTT, room, webhooks, etc.).
                return {
                    ...device,
                    ...updated,
                    switchStatus: device.switchStatus,
                };
            })
        );
    }, []);

    // Fetch live switch status (queried server-side over HTTP) and merge it into
    // the cards by device id. Safe to call repeatedly.
    const fetchStatuses = useCallback(async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/shelly/devices/status`);
            if (!response.ok) {
                return;
            }
            const statuses: { id: string; ip: string; output: boolean; inputStates?: boolean[] }[] = await response.json();
            const byId = new Map(statuses.map((status) => [status.id, status]));
            setDevices((prev) =>
                mirrorSharedTopics(
                    prev.map((device) => {
                        const id = device.device?.id?.toString();
                        const status = id !== undefined ? byId.get(id) : undefined;
                        if (status) {
                            return {
                                ...device,
                                inputStates: status.inputStates ?? device.inputStates,
                                switchStatus: { ...device.switchStatus, output: status.output },
                            };
                        }
                        return device;
                    })
                )
            );
        } catch (err) {
            console.error("Failed to fetch device statuses", err);
        }
    }, []);

    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/shelly/devices/detailed`);
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }
                const data: IDevice[] = await response.json();
                setDevices(data);

                if (data.some((device) => device.mqtt?.enable)) {
                    fetchStatuses();
                }
            } catch (err) {
                console.error("Failed to fetch devices", err);
                setError("Could not load devices from the server.");
            } finally {
                setLoading(false);
            }
        };

        fetchDevices();
    }, [fetchStatuses]);

    useEffect(() => {
        fetchGroups();
    }, [fetchGroups]);

    // Re-poll live status on an interval so the cards stay accurate even when the
    // page is left open (state changes, devices coming online at a new IP, etc.).
    useEffect(() => {
        const interval = setInterval(fetchStatuses, STATUS_POLL_MS);
        return () => clearInterval(interval);
    }, [fetchStatuses]);


    // Keep device state live: the server streams status updates over SSE (e.g.
    // after toggling a device from a card).
    useEffect(() => {
        const eventSource = new EventSource(`${BACKEND_URL}/shelly/listen`);

        eventSource.onmessage = (event) => {
            const data: IDevice = JSON.parse(event.data);
            setDevices((prev) =>
                mirrorSharedTopics(
                    prev.map((device) => {
                        // Prefer matching on the stable device id; fall back to IP.
                        const sameId = data.device?.id !== undefined && device.device?.id === data.device?.id;
                        const sameIp = data.ip && device.ip === data.ip;
                        return sameId || sameIp ? { ...device, switchStatus: data.switchStatus } : device;
                    })
                )
            );
        };

        return () => {
            eventSource.close();
        };
    }, []);

    return (
        <section className={style.devices}>
            <h2>Devices</h2>

            {loading ? (
                <p className={style.loading}>Loading devices…</p>
            ) : error ? (
                <p className={style.loading}>{error}</p>
            ) : devices.length === 0 ? (
                <div className={style.empty}>
                    <p>No devices have been registered yet.</p>
                    <p>
                        Try the{" "}
                        <button className={style.link} onClick={() => navigate("/scanner")}>
                            Scanner
                        </button>{" "}
                        first to discover devices on your network.
                    </p>
                </div>
            ) : (
                <div className={style["device-grid"]}>
                    {buildTiles(devices).map((tile) => (
                            <ShellyEntity
                                key={`${tile.device.device?.id ?? tile.device.ip}-${tile.inputIndex ?? 0}`}
                                device={tile.device}
                                displayName={tile.displayName}
                                inputIndex={tile.inputIndex}
                                lockInputSelection={tile.lockInputSelection}
                                linkedPowerStatus={tile.linkedPowerStatus}
                                mode="normal"
                                groups={groups}
                                onGroupsChanged={fetchGroups}
                                onDeviceUpdated={handleDeviceUpdated}
                                onStatusRefresh={fetchStatuses}
                            />
                        ))}
                </div>
            )}
        </section>
    );
};

export default Devices;
