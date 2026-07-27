import { useEffect, useState, useCallback } from "react";
import style from "./shelly-scanner.module.css";
import ProgressBar from "../progress-bar/ProgressBar";
import { BACKEND_URL } from "../../constants/env";
import ShellyEntity, { DeviceGroup } from "../shelly-entity/ShellyEntity";
import { IDevice } from "../../../../common/models/device.interface";
import { useSelector } from "react-redux";
import { RootState } from "../../store/store";

const ShellyScanner = () => {
    const [progress, setProgress] = useState(0);
    const [total, setTotal] = useState<number | null>(null);
    const [count, setCount] = useState(0);
    const [devices, setDevices] = useState<IDevice[]>([]);
    const [groups, setGroups] = useState<DeviceGroup[]>([]);
    const [mode, setMode] = useState<string>("dev");
    const [scanning, setScanning] = useState(false);

    const scanId = useSelector((state: RootState) => state.scanner.scanId);
    const scanTargets = useSelector((state: RootState) => state.scanner.scanTargets);

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

    useEffect(() => {
        fetchGroups();
    }, [fetchGroups]);

    useEffect(() => {
        const handleKeyPress = (() => {
            let buffer = "";

            return (e: KeyboardEvent) => {
                buffer += e.key.toLowerCase();

                // Keep buffer to last 5 characters
                if (buffer.length > 10) {
                    buffer = buffer.slice(buffer.length - 10);
                }

                if (buffer.includes("debug")) {
                    setMode("debug");
                }

                if (buffer.includes("normal")) {
                    setMode("normal");
                }

                if (buffer.includes("dev")) {
                    setMode("dev");
                }

                if (buffer.includes("scan")) {
                    // Restart the scan
                }
            };
        })();

        window.addEventListener("keydown", handleKeyPress);
        return () => {
            window.removeEventListener("keydown", handleKeyPress);
        };
    }, []);

    // Scan a single /24 range. Resolves with the devices found once the server
    // reports the scan is complete.
    const scanRange = (
        ip: string,
        onProgress: (completed: number, count: number, total: number) => void
    ): Promise<IDevice[]> =>
        new Promise((resolve) => {
            const eventSource = new EventSource(`${BACKEND_URL}/shelly/discover?ip=${ip}`);

            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.message === "Scan complete") {
                    eventSource.close();
                    resolve(data.devices ?? []);
                    return;
                }
                onProgress(data.completed ?? 0, data.count ?? 0, data.total ?? 0);
            };

            eventSource.onerror = () => {
                eventSource.close();
                resolve([]);
            };
        });

    // Run a scan whenever the user requests one (scanId increments per request).
    useEffect(() => {
        if (scanId === 0 || scanTargets.length === 0) {
            return;
        }

        let cancelled = false;

        const run = async () => {
            setDevices([]);
            setProgress(0);
            setCount(0);
            setTotal(null);
            setScanning(true);

            const accumulated: IDevice[] = [];
            let completedBase = 0;
            let successBase = 0;

            for (const ip of scanTargets) {
                if (cancelled) {
                    return;
                }

                let rangeTotal = 0;
                let rangeCount = 0;

                const found = await scanRange(ip, (completed, cnt, tot) => {
                    if (cancelled) {
                        return;
                    }
                    rangeTotal = tot;
                    rangeCount = cnt;
                    const overallTotal = tot * scanTargets.length;
                    setTotal(overallTotal || null);
                    setCount(successBase + cnt);
                    if (overallTotal) {
                        setProgress(((completedBase + completed) / overallTotal) * 100);
                    }
                });

                if (cancelled) {
                    return;
                }

                accumulated.push(...found);
                completedBase += rangeTotal;
                successBase += rangeCount;
                setDevices([...accumulated]);
            }

            setProgress(100);
            setScanning(false);
        };

        run();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scanId]);

    useEffect(() => {
        const eventSource = new EventSource(`${BACKEND_URL}/shelly/listen`);

        eventSource.onmessage = (event) => {
            const data: IDevice = JSON.parse(event.data);
            if (data.ip) {
                const newDeviceStates = devices.map((device) => (device.ip === data.ip ? data : device));
                setDevices(newDeviceStates);
            }
        };

        return () => {
            eventSource.close();
        };
    }, [devices]);

    return (
        <section className={style["shelly-scanner"]}>
            <h2>Network Scanner</h2>
            {scanId === 0 ? (
                <p>Select a network range and click Scan to begin.</p>
            ) : (
                <>
                    <ProgressBar progress={progress} />
                    <p>Progress: {total ? Math.round(progress) : scanning ? "Loading..." : "0"}%</p>
                    <p>Successful Responses: {count}</p>
                </>
            )}
            <article>
                {devices &&
                    devices
                        .sort((a, b) =>
                            (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" }) !== 0
                                ? (a?.room?.name || "Unknown").localeCompare(b?.room?.name || "Unknown", undefined, { sensitivity: "base" })
                                : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
                        )
                        .map((device, index) => (
                            <ShellyEntity
                                key={`shelly-${index}`}
                                device={device}
                                mode={mode}
                                groups={groups}
                                onGroupsChanged={fetchGroups}
                            />
                        ))}
            </article>
        </section>
    );
};

export default ShellyScanner;
