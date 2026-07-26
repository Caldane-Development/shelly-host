import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import style from "./devices.module.css";
import { BACKEND_URL } from "../../constants/env";
import { IDevice } from "../../../../common/models/device.interface";
import ShellyEntity from "../shelly-entity/ShellyEntity";

const Devices = () => {
    const navigate = useNavigate();
    const [devices, setDevices] = useState<IDevice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/shelly/devices/detailed`);
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }
                const data: IDevice[] = await response.json();
                setDevices(data);

                // Fetch live switch status for MQTT-enabled devices and merge it
                // into the cards once it arrives (queried over HTTP server-side).
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

        const fetchStatuses = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/shelly/devices/status`);
                if (!response.ok) {
                    return;
                }
                const statuses: { id: string; ip: string; output: boolean }[] = await response.json();
                const byId = new Map(statuses.map((status) => [status.id, status.output]));
                setDevices((prev) =>
                    prev.map((device) => {
                        const id = device.device?.id?.toString();
                        if (id !== undefined && byId.has(id)) {
                            return { ...device, switchStatus: { ...device.switchStatus, output: byId.get(id)! } };
                        }
                        return device;
                    })
                );
            } catch (err) {
                console.error("Failed to fetch device statuses", err);
            }
        };

        fetchDevices();
    }, []);

    // Keep device state live: the server streams status updates over SSE (e.g.
    // after toggling a device from a card).
    useEffect(() => {
        const eventSource = new EventSource(`${BACKEND_URL}/shelly/listen`);

        eventSource.onmessage = (event) => {
            const data: IDevice = JSON.parse(event.data);
            setDevices((prev) =>
                prev.map((device) => {
                    // Prefer matching on the stable device id; fall back to IP.
                    const sameId = data.device?.id !== undefined && device.device?.id === data.device?.id;
                    const sameIp = data.ip && device.ip === data.ip;
                    return sameId || sameIp ? { ...device, switchStatus: data.switchStatus } : device;
                })
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
                            <ShellyEntity key={device.device?.id ?? device.ip} device={device} mode="normal" />
                        ))}
                </div>
            )}
        </section>
    );
};

export default Devices;
