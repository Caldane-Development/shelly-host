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

    // Fetch live switch status (queried server-side over HTTP) and merge it into
    // the cards by device id. Safe to call repeatedly.
    const fetchStatuses = useCallback(async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/shelly/devices/status`);
            if (!response.ok) {
                return;
            }
            const statuses: { id: string; ip: string; output: boolean }[] = await response.json();
            const byId = new Map(statuses.map((status) => [status.id, status.output]));
            setDevices((prev) =>
                mirrorSharedTopics(
                    prev.map((device) => {
                        const id = device.device?.id?.toString();
                        if (id !== undefined && byId.has(id)) {
                            return { ...device, switchStatus: { ...device.switchStatus, output: byId.get(id)! } };
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
                    {devices
                        .sort((a, b) =>
                            (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" }) !== 0
                                ? (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" })
                                : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
                        )
                        .map((device) => (
                            <ShellyEntity
                                key={device.device?.id ?? device.ip}
                                device={device}
                                mode="normal"
                                groups={groups}
                                onGroupsChanged={fetchGroups}
                            />
                        ))}
                </div>
            )}
        </section>
    );
};

export default Devices;
