import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import style from "./devices.module.css";
import { BACKEND_URL } from "../../constants/env";

interface StoredDevice {
    id: string;
    name: string;
    type: string;
    ip: string;
    roomId: number;
    ssid: string;
}

const Devices = () => {
    const navigate = useNavigate();
    const [devices, setDevices] = useState<StoredDevice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/shelly/devices`);
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }
                const data: StoredDevice[] = await response.json();
                setDevices(data);
            } catch (err) {
                console.error("Failed to fetch devices", err);
                setError("Could not load devices from the server.");
            } finally {
                setLoading(false);
            }
        };

        fetchDevices();
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
                <div className={style["device-list"]}>
                    {devices.map((device) => (
                        <div key={device.id} className={style.device}>
                            <span className={style.name}>{device.name}</span>
                            <div className={style.meta}>
                                <span>{device.type}</span>
                                <span>{device.ip}</span>
                                <span>Room {device.roomId}</span>
                                {device.ssid && <span>{device.ssid}</span>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

export default Devices;
