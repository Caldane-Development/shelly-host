import { Router } from "express";
import { Request, Response } from "express";
import deviceList from "../assets/json/device-list.json";
import roomList from "../assets/json/room-list.json";
import config from "../assets/json/config.json";
import { logger } from "../logger";
import os from "os";
import { composeShellyDevice, discoverShelly, shellyActivateMqtt, shellyActivateWebhook, shellyCloudDevices, shellyCloudRooms, shellyGetMqttSettings, shellyReboot, shellySetWifi, shellyWebhookList, shellyActivateCompanionWebhook, shellyDeleteCompanionWebhooks, shellyDetachInput, shellyCheckForUpdate, shellyUpdateFirmware } from "../utils/discovery.helper";
import { MqttResponse } from "../../../common/models/mqtt.interface";
import { DeviceList, IDevice } from "../../../common/models/device.interface";
import { Hook } from "../../../common/models/webhooks.interface";
import { mqttAddListener, mqtt as mqttClient } from "../utils/mqtt.helper";
import { getStoredDevices, getStoredIDevices, getEnabledDevices, saveDiscoveredDevices } from "../utils/device.helper";
import { getStoredRooms, saveDiscoveredRooms } from "../utils/room.helper";
import { getWifiCredentialBySsid } from "../utils/wifi.helper";
import { getSiteConfigCached } from "../utils/site-config.helper";
import { postRequest } from "../utils/http.helper";

export const shellyRouter = Router();

let repairRpcInFlight = false;
let repairRpcRunCounter = 0;
const repairRpcRunHistory = new Map<string, {
    createdAt: string;
    diagnostics: Array<{
        traceId: string;
        runId: string;
        ip: string;
        name: string;
        attempt: string;
        phase: "list" | "update" | "verify" | "reboot";
        ok: boolean;
        durationMs: number;
        detail?: string;
    }>;
    failures: Array<{ ip: string; name: string; reason: string }>;
    retry: {
        secondPassAttempted: number;
        secondPassRecovered: number;
        thirdPassAttempted: number;
        thirdPassRecovered: number;
    };
}>();
const repairRpcRunOrder: string[] = [];
const MAX_REPAIR_RPC_HISTORY = 20;

const FIRMWARE_AUTO_UPDATE_ENABLED = (process.env.FIRMWARE_AUTO_UPDATE_ENABLED || "true").toLowerCase() !== "false";
const FIRMWARE_AUTO_UPDATE_INTERVAL_HOURS = Math.max(1, Number(process.env.FIRMWARE_AUTO_UPDATE_INTERVAL_HOURS || 24));
const FIRMWARE_AUTO_UPDATE_INTERVAL_MS = FIRMWARE_AUTO_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;

let firmwareAutoUpdateInFlight = false;

interface FirmwareRunEntry {
    ip: string;
    name: string;
    fwId?: string;
    hasStableUpdate: boolean;
    stableVersion?: string;
    updateTriggered: boolean;
    error?: string;
}

interface FirmwareRunSummary {
    trigger: string;
    startedAt: string;
    finishedAt: string;
    applyUpdates: boolean;
    total: number;
    checked: number;
    needsStableUpdate: number;
    updateTriggered: number;
    failed: number;
    results: FirmwareRunEntry[];
}

const runStableFirmwareAutoUpdate = async (trigger: string, applyUpdates: boolean): Promise<FirmwareRunSummary> => {
    if (firmwareAutoUpdateInFlight) {
        throw new Error("Firmware auto-update run already in progress.");
    }

    firmwareAutoUpdateInFlight = true;
    const startedAt = new Date().toISOString();

    try {
        const devices = await getStoredIDevices();
        const candidates = devices.filter((device) => Boolean(device.ip));
        const results: FirmwareRunEntry[] = [];

        for (const device of candidates) {
            const ip = device.ip;
            const name = device.name || "(unknown)";
            const fwId = (device.device as unknown as { fw_id?: string } | undefined)?.fw_id;

            if (!ip) {
                continue;
            }

            try {
                const updateInfo = await shellyCheckForUpdate(ip, {
                    retries: 3,
                    delayMs: 1200,
                    timeoutMs: 12000,
                    connectionHeader: "close",
                });

                const stable = updateInfo?.stable;
                const hasStableUpdate = Boolean(stable);

                let updateTriggered = false;
                let error: string | undefined;

                if (hasStableUpdate && applyUpdates) {
                    const updateResult = await shellyUpdateFirmware(ip, "stable", {
                        retries: 2,
                        delayMs: 1500,
                        timeoutMs: 12000,
                        connectionHeader: "close",
                    });

                    if (updateResult.ok) {
                        updateTriggered = true;
                    } else {
                        error = updateResult.message || "Failed to trigger stable firmware update";
                    }
                }

                results.push({
                    ip,
                    name,
                    fwId,
                    hasStableUpdate,
                    stableVersion: typeof stable?.version === "string" ? stable.version : undefined,
                    updateTriggered,
                    error,
                });
            } catch (error: Error | any) {
                results.push({
                    ip,
                    name,
                    fwId,
                    hasStableUpdate: false,
                    updateTriggered: false,
                    error: error?.message || "Unknown error",
                });
            }
        }

        const summary: FirmwareRunSummary = {
            trigger,
            startedAt,
            finishedAt: new Date().toISOString(),
            applyUpdates,
            total: candidates.length,
            checked: results.length,
            needsStableUpdate: results.filter((entry) => entry.hasStableUpdate).length,
            updateTriggered: results.filter((entry) => entry.updateTriggered).length,
            failed: results.filter((entry) => Boolean(entry.error)).length,
            results,
        };

        logger.info(`[server]: Firmware stable update run (${trigger}) complete. ${JSON.stringify({
            applyUpdates: summary.applyUpdates,
            total: summary.total,
            checked: summary.checked,
            needsStableUpdate: summary.needsStableUpdate,
            updateTriggered: summary.updateTriggered,
            failed: summary.failed,
        })}`);

        return summary;
    } finally {
        firmwareAutoUpdateInFlight = false;
    }
};

if (FIRMWARE_AUTO_UPDATE_ENABLED) {
    setInterval(() => {
        runStableFirmwareAutoUpdate("scheduler", true).catch((error: Error | any) => {
            logger.error(`[server]: Firmware auto-update scheduler run failed: ${error?.message || error}`);
        });
    }, FIRMWARE_AUTO_UPDATE_INTERVAL_MS);

    logger.info(`[server]: Firmware auto-update scheduler enabled (stable track), interval ${FIRMWARE_AUTO_UPDATE_INTERVAL_HOURS}h`);
}

const networkInterfaces = os.networkInterfaces();

function getLocalIpAddress() {
    const networkAddresses = [];
    for (const name of Object.keys(networkInterfaces)) {
        const nic = networkInterfaces[name];
        if (nic === undefined) {
            continue;
        }
        for (const net of nic) {
            // Skip over non-IPv4 and internal (loopback) addresses
            if (net.family === "IPv4" && !net.internal) {
                logger.info(`Found IP address: ${net.address}`);
                networkAddresses.push(net.address);
            }
        }
    }
    const localIpAddress = networkAddresses.sort((a, b) => b.localeCompare(a))[0] || null;
    logger.info(`Selected Local IP address: ${localIpAddress}`);
    return localIpAddress;
}

const localIpAddress = getLocalIpAddress();

if (!localIpAddress) {
    console.log("Could not find local IP address");
}

// Live Shelly-cloud device/room catalog with a short in-memory cache so an
// "All ranges" scan (sequential per-subnet requests) doesn't re-hit the cloud
// API for every range. Falls back to the bundled static snapshot when no cloud
// auth key is configured or the cloud is unreachable (e.g. offline).
interface DeviceCatalog {
    devices: DeviceList;
    rooms: typeof roomList;
}

const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { data: DeviceCatalog; expires: number } | null = null;

const resolveDeviceCatalog = async (): Promise<DeviceCatalog> => {
    const staticCatalog: DeviceCatalog = { devices: deviceList as DeviceList, rooms: roomList };

    if (!getSiteConfigCached().cloudAuthKey) {
        logger.info("[server]: No Shelly cloud auth key set; using bundled device/room snapshot");
        return staticCatalog;
    }

    if (catalogCache && catalogCache.expires > Date.now()) {
        return catalogCache.data;
    }

    try {
        const [cloudRooms, cloudDevices] = await Promise.all([shellyCloudRooms(), shellyCloudDevices()]);
        const resolved: DeviceCatalog = {
            devices: cloudDevices?.isok && cloudDevices?.data?.devices ? (cloudDevices as DeviceList) : staticCatalog.devices,
            rooms: cloudRooms?.isok && cloudRooms?.data?.rooms ? cloudRooms : staticCatalog.rooms,
        };
        catalogCache = { data: resolved, expires: Date.now() + CATALOG_TTL_MS };
        logger.info("[server]: Loaded live Shelly cloud device/room catalog");
        return resolved;
    } catch (error: Error | any) {
        logger.warn(`[server]: Shelly cloud fetch failed, using bundled snapshot. Error: ${error?.message}`);
        return staticCatalog;
    }
};

shellyRouter.get("/listen", async (_: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const transactionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    mqttAddListener(transactionId, (device: IDevice) => {
        res.write(`data: ${JSON.stringify(device)}\n\n`);
    });
});

shellyRouter.get("/discover", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const ipAddress: string | null = req.query.ip?.toString() || localIpAddress;

    if (!ipAddress) {
        res.status(404).send("Cannot discover devices when not on a network.");
        return;
    }
    const [net1, net2, net3] = ipAddress.split(".");
    const catalog = await resolveDeviceCatalog();
    const shellyRooms = catalog.rooms;
    const shellyDevices: DeviceList = catalog.devices;
    const discoveredDevices: Promise<IDevice | null>[] = []; // Array to hold discovered devices for logging
    const counts = { successfulResponses: 0, completedRequests: 0, totalIPs: config.discover.dhcp.end - config.discover.dhcp.start };

    const requestComplete = (ip: string) => {
        counts.completedRequests++;
        res.write(`data: { "ip": "${ip}", "count": ${counts.successfulResponses}, "completed": ${counts.completedRequests}, "total": ${counts.totalIPs} }\n\n`);
    };

    const discoverSuccess = () => {
        counts.successfulResponses++;
    };

    for (let net4 = config.discover.dhcp.start; net4 < config.discover.dhcp.end; net4++) {
        const ip = `${net1}.${net2}.${net3}.${net4}`;
        discoveredDevices.push(composeShellyDevice(ip, shellyRooms, shellyDevices, requestComplete, discoverSuccess));
    }

    const foundDevices = (await Promise.all(discoveredDevices)).filter((device) => device !== null && device !== undefined);

    const mqttSettings = await Promise.all(
        foundDevices.filter((device) => device !== null && device?.mqtt?.connected).map((device) => device && shellyGetMqttSettings(device.ip))
    );
    const webhooks = await Promise.all(
        foundDevices.filter((device) => device?.room).map((device) => device && shellyWebhookList(device.ip))
    );

    logger.info(`[server]: Discovered ${foundDevices.length} devices`);

    const data: { message: string; completed: number; successful: number; total: number; devices: IDevice[] } = {
        message: "Scan complete",
        completed: counts.completedRequests,
        successful: counts.successfulResponses,
        total: counts.totalIPs,
        devices: foundDevices
            .filter((device) => device)
            .map((device): IDevice => {
                if (!device) {
                    throw new Error("Device is null or undefined");
                }

                const mqttSetting: MqttResponse = mqttSettings.find((setting) => setting?.ip === device?.ip);
                const webhookSetting = webhooks.filter(setting => setting?.result.hooks.length).find((setting) => setting?.ip === device?.ip);
                return {
                    ...device,
                    mqtt: { ...device.mqtt, ...mqttSetting?.result },
                    webhooks: webhookSetting
                } as IDevice;
            }),
    };

    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end();

    await saveDiscoveredDevices(data.devices);
    await saveDiscoveredRooms(data.devices);
});

shellyRouter.get("/rooms", async (_: Request, res: Response) => {
    try {
        const storedRooms = await getStoredRooms();
        res.json(storedRooms);
    } catch (error) {
        logger.error(`[server]: Failed to fetch rooms: ${error}`);
        res.status(500).send("Failed to fetch rooms");
    }
});

shellyRouter.get("/devices", async (_: Request, res: Response) => {
    try {
        const storedDevices = await getStoredDevices();
        res.json(storedDevices);
    } catch (error) {
        logger.error(`[server]: Failed to fetch devices: ${error}`);
        res.status(500).send("Failed to fetch devices");
    }
});

shellyRouter.get("/devices/detailed", async (_: Request, res: Response) => {
    try {
        const storedDevices = await getStoredIDevices();
        res.json(storedDevices);
    } catch (error) {
        logger.error(`[server]: Failed to fetch detailed devices: ${error}`);
        res.status(500).send("Failed to fetch detailed devices");
    }
});

// Query live switch status for every MQTT-enabled stored device over HTTP (the
// same source the scanner uses) and return it directly. This avoids relying on
// MQTT broker topology, which may differ per device.
shellyRouter.get("/devices/status", async (_: Request, res: Response) => {
    try {
        const enabledDevices = await getEnabledDevices();
        const statuses = await Promise.all(
            enabledDevices.map(async (device) => {
                const result = await discoverShelly(device.ip);
                return { id: device.id.toString(), ip: device.ip, output: Boolean(result?.["switch:0"]?.output) };
            })
        );
        res.json(statuses);
    } catch (error) {
        logger.error(`[server]: Failed to fetch device statuses: ${error}`);
        res.status(500).send("Failed to fetch device statuses");
    }
});

shellyRouter.post("/devices/firmware/auto-update/run-now", async (req: Request, res: Response) => {
    const applyUpdates = req.body?.applyUpdates === true;

    try {
        const summary = await runStableFirmwareAutoUpdate("manual", applyUpdates);
        res.json(summary);
    } catch (error: Error | any) {
        res.status(409).json({ error: error?.message || "Firmware run already in progress" });
    }
});

shellyRouter.post("/devices/mqtt/reapply", async (_: Request, res: Response) => {
    const broker = getSiteConfigCached().mqtt.trim();
    if (!broker) {
        res.status(400).json({ error: "Site MQTT broker is not configured." });
        return;
    }

    try {
        const storedDevices = await getStoredIDevices();
        const mqttEnabledDevices = storedDevices.filter((device) => Boolean(device.mqtt?.enable));

        if (mqttEnabledDevices.length === 0) {
            res.json({
                broker,
                total: 0,
                succeeded: 0,
                failed: 0,
                failures: [] as { ip: string; name: string; reason: string }[],
            });
            return;
        }

        const failures: { ip: string; name: string; reason: string }[] = [];
        let succeeded = 0;

        for (const device of mqttEnabledDevices) {
            try {
                if (!device.ip) {
                    failures.push({ ip: "", name: device.name || "(unknown)", reason: "Missing device IP" });
                    continue;
                }

                const updated = await shellyActivateMqtt(device.ip, device, { server: broker });
                if (!updated) {
                    failures.push({ ip: device.ip, name: device.name || "(unknown)", reason: "MQTT.SetConfig failed" });
                    continue;
                }

                await shellyReboot(device.ip);
                await saveDiscoveredDevices([updated]);
                mqttClient.status(updated.device);
                succeeded++;
            } catch (error: Error | any) {
                failures.push({
                    ip: device.ip || "",
                    name: device.name || "(unknown)",
                    reason: error?.message || "Unknown error",
                });
            }
        }

        res.json({
            broker,
            total: mqttEnabledDevices.length,
            succeeded,
            failed: failures.length,
            failures,
        });
    } catch (error) {
        logger.error(`[server]: Failed to reapply MQTT config to all devices: ${error}`);
        res.status(500).json({ error: "Failed to reapply MQTT config to all devices" });
    }
});

const normalizeHost = (value: string): string =>
    value.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").trim().toLocaleLowerCase();

const extractUrlHost = (urlValue: string): string => {
    try {
        return normalizeHost(new URL(urlValue).host);
    } catch {
        const match = urlValue.match(/^https?:\/\/([^/]+)/i);
        return normalizeHost(match?.[1] ?? "");
    }
};

const isManagedWebhookUrl = (urlValue: string): boolean => {
    try {
        return new URL(urlValue).pathname.startsWith("/api/");
    } catch {
        return /\/api\//i.test(urlValue);
    }
};

const isRpcActionUrl = (urlValue: string): boolean => {
    try {
        return new URL(urlValue).pathname.toLocaleLowerCase().startsWith("/rpc");
    } catch {
        return /^https?:\/\/[^/]+\/rpc(\/|$|\?)/i.test(urlValue);
    }
};

const replaceWebhookHost = (urlValue: string, host: string): string => {
    try {
        const parsed = new URL(urlValue);
        parsed.host = host;
        return parsed.toString();
    } catch {
        return urlValue.replace(/^https?:\/\/[^/]+/i, `http://${host}`);
    }
};

const isRpcError = (payload: unknown): payload is { error: { message?: string; code?: number } } => {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    return "error" in payload;
};

const isManagedToggleHook = (hook: Hook): boolean => {
    const isToggleEvent = hook.event === "input.toggle_on" || hook.event === "input.toggle_off";
    const urls = hook.urls ?? [];
    const hasManagedUrl = urls.some((urlValue) => isManagedWebhookUrl(urlValue) && !isRpcActionUrl(urlValue));
    return isToggleEvent && hasManagedUrl;
};

const replaceManagedToggleHooks = async (ip: string): Promise<void> => {
    try {
        const existing = await shellyWebhookList(ip, {
            retries: 5,
            delayMs: 1200,
            timeoutMs: 10000,
            connectionHeader: "close",
        });
        const hooks = existing?.result?.hooks ?? [];
        const managedToggleHooks = hooks.filter(isManagedToggleHook);

        for (const hook of managedToggleHooks) {
            try {
                const deleteResult = await postRequest<Record<string, unknown>>(
                    `http://${ip}/rpc/`,
                    {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "User-Agent": "ShellyApp/1.0",
                        Connection: "close",
                    },
                    {
                        id: 0,
                        method: "Webhook.Delete",
                        params: { id: hook.id },
                    },
                    5,
                    1200,
                    10000
                );

                if (isRpcError(deleteResult)) {
                    logger.warn(`[server]: Managed webhook delete RPC error on ${ip} for hook ${hook.id}: ${deleteResult.error?.message || "unknown"}`);
                }
            } catch (error: Error | any) {
                logger.warn(`[server]: Managed webhook delete failed on ${ip} for hook ${hook.id}: ${error?.message || error}`);
            }
        }
    } catch (error: Error | any) {
        logger.warn(`[server]: Managed webhook dedup skipped on ${ip}: ${error?.message || error}`);
    }
};

const toSlug = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();

const buildManagedToggleUrl = (webhookHost: string, siteName: string, roomId: number, targetName: string, targetClientName: string): string => {
    const room = Number.isFinite(roomId) ? String(roomId) : "0";
    return `http://${webhookHost}/api/message/srd/${toSlug(siteName)}/${room}/${toSlug(targetName)}/switch/message/toggle/${toSlug(targetClientName)}`;
};

const inferManagedWebhookHost = async (devices: IDevice[]): Promise<string> => {
    const counts = new Map<string, number>();

    for (const device of devices) {
        if (!device.ip) {
            continue;
        }
        try {
            const webhookList = await shellyWebhookList(device.ip);
            const hooks = webhookList?.result?.hooks ?? [];
            for (const hook of hooks) {
                for (const urlValue of hook.urls ?? []) {
                    if (!isManagedWebhookUrl(urlValue) || isRpcActionUrl(urlValue)) {
                        continue;
                    }
                    const host = extractUrlHost(urlValue);
                    if (!host) {
                        continue;
                    }
                    counts.set(host, (counts.get(host) ?? 0) + 1);
                }
            }
        } catch {
            // Best-effort inference only; per-device failures are handled later.
        }
    }

    let winner = "";
    let winnerCount = 0;
    counts.forEach((count, host) => {
        if (count > winnerCount) {
            winner = host;
            winnerCount = count;
        }
    });

    return winner;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForRpcReady = async (ip: string, maxAttempts: number = 15, delayMs: number = 1500): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const probe = await postRequest<{ result?: { id?: string } }>(
                `http://${ip}/rpc/`,
                {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "User-Agent": "ShellyApp/1.0",
                    Connection: "close",
                },
                {
                    id: 0,
                    method: "Shelly.GetDeviceInfo",
                },
                1,
                250,
                3000
            );

            if (probe?.result) {
                return true;
            }
        } catch {
            // Device may still be rebooting; keep polling until max attempts.
        }

        await sleep(delayMs);
    }

    return false;
};

const getInputMode = async (ip: string): Promise<string> => {
    const switchConfig = await postRequest<{ result?: { in_mode?: string } }>(
        `http://${ip}/rpc/`,
        {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "ShellyApp/1.0",
            Connection: "close",
        },
        {
            id: 0,
            method: "Switch.GetConfig",
            params: { id: 0 },
        },
        7,
        1200,
        10000
    );

    return switchConfig?.result?.in_mode || "";
};

interface DetachedModeAssessment {
    verified: boolean;
    detachWriteSucceeded: boolean;
    precheckReadSuccess: boolean;
    verifyReadSuccess: boolean;
    lastObservedMode: string;
}

const ensureDetachedMode = async (ip: string, maxAttempts: number = 6): Promise<DetachedModeAssessment> => {
    const assessment: DetachedModeAssessment = {
        verified: false,
        detachWriteSucceeded: false,
        precheckReadSuccess: false,
        verifyReadSuccess: false,
        lastObservedMode: "",
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // If the device is already detached, do not force another write.
        // This avoids failing the flow on transient SetConfig transport errors.
        try {
            const currentMode = await getInputMode(ip);
            assessment.precheckReadSuccess = true;
            assessment.lastObservedMode = currentMode || assessment.lastObservedMode;
            if (currentMode === "detached") {
                assessment.verified = true;
                return assessment;
            }
        } catch (error: Error | any) {
            logger.warn(`[server]: Detach pre-check attempt ${attempt}/${maxAttempts} for ${ip} failed: ${error?.message || error}`);
        }

        try {
            await shellyDetachInput(ip, 0, {
                retries: 7,
                delayMs: 1500,
                timeoutMs: 12000,
                connectionHeader: "close",
            });
            assessment.detachWriteSucceeded = true;
        } catch (error: Error | any) {
            logger.warn(`[server]: Detach set attempt ${attempt}/${maxAttempts} for ${ip} failed: ${error?.message || error}`);
        }

        try {
            const inMode = await getInputMode(ip);
            assessment.verifyReadSuccess = true;
            assessment.lastObservedMode = inMode || assessment.lastObservedMode;
            if (inMode === "detached") {
                assessment.verified = true;
                return assessment;
            }
            logger.warn(`[server]: Detach verify attempt ${attempt}/${maxAttempts} for ${ip} returned in_mode=${inMode || "unknown"}`);
        } catch (error: Error | any) {
            logger.warn(`[server]: Detach verify attempt ${attempt}/${maxAttempts} for ${ip} failed: ${error?.message || error}`);
        }

        await sleep(1200);
    }

    return assessment;
};

const hasManagedToggleActions = async (ip: string): Promise<boolean> => {
    const webhookList = await shellyWebhookList(ip, {
        retries: 5,
        delayMs: 1200,
        timeoutMs: 10000,
        connectionHeader: "close",
    });

    const hooks = webhookList?.result?.hooks ?? [];
    const hasOn = hooks.some((hook) => hook.enable !== false && hook.event === "input.toggle_on");
    const hasOff = hooks.some((hook) => hook.enable !== false && hook.event === "input.toggle_off");

    return hasOn && hasOff;
};

const canUseDetachedFallback = async (
    ip: string,
    assessment: DetachedModeAssessment,
    requireDetachWrite: boolean,
    requireManagedHooks: boolean = false
): Promise<boolean> => {
    if (assessment.verified) {
        return true;
    }

    const hadAnyReadSuccess = assessment.precheckReadSuccess || assessment.verifyReadSuccess;
    if (hadAnyReadSuccess) {
        return false;
    }

    if (requireDetachWrite && !assessment.detachWriteSucceeded) {
        return false;
    }

    if (!requireManagedHooks) {
        return true;
    }

    return hasManagedToggleActions(ip);
};

shellyRouter.post("/devices/webhooks/reapply", async (_: Request, res: Response) => {
    const webhookHost = getSiteConfigCached().webhook.trim();
    if (!webhookHost) {
        res.status(400).json({ error: "Site webhook host is not configured." });
        return;
    }

    const desiredHost = normalizeHost(webhookHost);
    try {
        const storedDevices = await getStoredIDevices();
        if (storedDevices.length === 0) {
            res.json({
                webhookHost,
                total: 0,
                checked: 0,
                updated: 0,
                unchanged: 0,
                failed: 0,
                failures: [] as { ip: string; name: string; reason: string }[],
            });
            return;
        }

        const failures: { ip: string; name: string; reason: string }[] = [];
        let updated = 0;
        let unchanged = 0;
        let checked = 0;

        for (const device of storedDevices) {
            try {
                if (!device.ip) {
                    failures.push({ ip: "", name: device.name || "(unknown)", reason: "Missing device IP" });
                    continue;
                }

                const webhookList = await shellyWebhookList(device.ip);
                checked++;
                const hooks = webhookList?.result?.hooks ?? [];
                const managedHooks = hooks.filter((hook) => (hook.urls ?? []).some(isManagedWebhookUrl));

                const hasIncorrectHost = managedHooks.some((hook) => (hook.urls ?? []).some((urlValue) => {
                    const currentHost = extractUrlHost(urlValue);
                    return currentHost !== "" && currentHost !== desiredHost;
                }));

                if (!hasIncorrectHost) {
                    unchanged++;
                    continue;
                }

                for (const hook of managedHooks) {
                    const urls = hook.urls ?? [];
                    const nextUrls = urls.map((urlValue) => {
                        if (!isManagedWebhookUrl(urlValue)) {
                            return urlValue;
                        }
                        const currentHost = extractUrlHost(urlValue);
                        if (!currentHost || currentHost === desiredHost) {
                            return urlValue;
                        }
                        return replaceWebhookHost(urlValue, webhookHost);
                    });

                    const updateBody = {
                        id: 0,
                        method: "Webhook.Update",
                        params: {
                            id: hook.id,
                            cid: hook.cid,
                            enable: hook.enable,
                            event: hook.event,
                            name: hook.name,
                            ssl_ca: hook.ssl_ca,
                            urls: nextUrls,
                            condition: hook.condition,
                            repeat_period: hook.repeat_period,
                        } as Hook,
                    };

                    const updateResult = await postRequest<Record<string, unknown>>(
                        `http://${device.ip}/rpc/`,
                        {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "User-Agent": "ShellyApp/1.0",
                            Connection: "keep-alive",
                        },
                        updateBody
                    );

                    if (isRpcError(updateResult)) {
                        const message = updateResult.error?.message || "Webhook.Update RPC error";
                        throw new Error(message);
                    }
                }

                const verify = await shellyWebhookList(device.ip);
                const verifyHooks = verify?.result?.hooks ?? [];
                const stillWrong = verifyHooks
                    .filter((hook) => (hook.urls ?? []).some(isManagedWebhookUrl))
                    .some((hook) => (hook.urls ?? []).some((urlValue) => {
                        const currentHost = extractUrlHost(urlValue);
                        return currentHost !== "" && currentHost !== desiredHost;
                    }));

                if (stillWrong) {
                    failures.push({ ip: device.ip, name: device.name || "(unknown)", reason: "Webhook host still mismatched after update" });
                    continue;
                }

                await shellyReboot(device.ip);
                updated++;
            } catch (error: Error | any) {
                failures.push({
                    ip: device.ip || "",
                    name: device.name || "(unknown)",
                    reason: error?.message || "Unknown error",
                });
            }
        }

        res.json({
            webhookHost,
            total: storedDevices.length,
            checked,
            updated,
            unchanged,
            failed: failures.length,
            failures,
        });
    } catch (error) {
        logger.error(`[server]: Failed to reapply webhook host to devices: ${error}`);
        res.status(500).json({ error: "Failed to reapply webhook host to devices" });
    }
});

shellyRouter.get("/devices/webhooks/audit", async (_: Request, res: Response) => {
    const webhookHost = getSiteConfigCached().webhook.trim();
    const desiredHost = normalizeHost(webhookHost);

    try {
        const storedDevices = await getStoredIDevices();

        const failures: Array<{ ip: string; name: string; reason: string }> = [];
        const findings: Array<{
            ip: string;
            name: string;
            hookId: number;
            event: string;
            url: string;
            reason: "rpc_url" | "wrong_host";
            currentHost: string;
            expectedHost: string;
        }> = [];

        let checked = 0;

        for (const device of storedDevices) {
            try {
                if (!device.ip) {
                    failures.push({ ip: "", name: device.name || "(unknown)", reason: "Missing device IP" });
                    continue;
                }

                const webhookList = await shellyWebhookList(device.ip);
                checked++;
                const hooks = webhookList?.result?.hooks ?? [];

                for (const hook of hooks) {
                    for (const urlValue of hook.urls ?? []) {
                        const currentHost = extractUrlHost(urlValue);

                        if (isRpcActionUrl(urlValue)) {
                            findings.push({
                                ip: device.ip,
                                name: device.name || "(unknown)",
                                hookId: Number(hook.id),
                                event: hook.event || "",
                                url: urlValue,
                                reason: "rpc_url",
                                currentHost,
                                expectedHost: desiredHost,
                            });
                            continue;
                        }

                        if (desiredHost !== "" && isManagedWebhookUrl(urlValue) && currentHost !== "" && currentHost !== desiredHost) {
                            findings.push({
                                ip: device.ip,
                                name: device.name || "(unknown)",
                                hookId: Number(hook.id),
                                event: hook.event || "",
                                url: urlValue,
                                reason: "wrong_host",
                                currentHost,
                                expectedHost: desiredHost,
                            });
                        }
                    }
                }
            } catch (error: Error | any) {
                failures.push({
                    ip: device.ip || "",
                    name: device.name || "(unknown)",
                    reason: error?.message || "Unknown error",
                });
            }
        }

        const affectedDevices = new Set(findings.map((finding) => `${finding.ip}|${finding.name}`));
        const rpcCount = findings.filter((finding) => finding.reason === "rpc_url").length;
        const wrongHostCount = findings.filter((finding) => finding.reason === "wrong_host").length;

        res.json({
            webhookHost,
            expectedHost: desiredHost,
            total: storedDevices.length,
            checked,
            affectedDevices: affectedDevices.size,
            findings: findings.length,
            rpcUrlFindings: rpcCount,
            wrongHostFindings: wrongHostCount,
            failed: failures.length,
            failures,
            results: findings,
        });
    } catch (error) {
        logger.error(`[server]: Failed to audit webhook URLs on devices: ${error}`);
        res.status(500).json({ error: "Failed to audit webhook URLs on devices" });
    }
});

shellyRouter.post("/devices/webhooks/repair-rpc", async (req: Request, res: Response) => {
    if (repairRpcInFlight) {
        res.status(409).json({ error: "RPC repair already running" });
        return;
    }

    repairRpcInFlight = true;
    const runId = `repair-${Date.now()}-${++repairRpcRunCounter}`;
    const siteConfig = getSiteConfigCached();
    let webhookHost = siteConfig.webhook.trim();
    const rpcTuning = {
        retries: 5,
        delayMs: 1200,
        timeoutMs: 10000,
        connectionHeader: "close" as const,
    };
    const pacing = {
        controllerBatchSize: 2,
        interControllerDelayMs: 250,
        interControllerJitterMs: 350,
        betweenBatchDelayMs: 900,
    };
    const transientRetryPattern = /(ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)/i;
    const thirdPassTuning = {
        retries: 7,
        delayMs: 1800,
        timeoutMs: 15000,
        connectionHeader: "close" as const,
    };

    try {
        const storedDevices = await getStoredIDevices();
        const requestedControllerIps = Array.isArray(req.body?.controllerIps)
            ? req.body.controllerIps.map((value: unknown) => String(value || "").trim()).filter((value: string) => value !== "")
            : [];

        const requestFilter = requestedControllerIps.length > 0 ? new Set(requestedControllerIps) : null;
        const selectedControllers = requestFilter
            ? storedDevices.filter((device) => Boolean(device.ip) && requestFilter.has(device.ip))
            : storedDevices;
        const skippedRequestedIps = requestFilter
            ? requestedControllerIps.filter((ip: string) => !selectedControllers.some((device) => device.ip === ip))
            : [];

        if (!webhookHost) {
            webhookHost = await inferManagedWebhookHost(selectedControllers);
        }
        if (!webhookHost) {
            res.status(400).json({ error: "Site webhook host is not configured and could not be inferred from existing managed webhooks." });
            return;
        }

        const byIp = new Map(storedDevices.filter((d) => Boolean(d.ip)).map((d) => [d.ip, d]));

        const failures: Array<{ ip: string; name: string; reason: string }> = [];
        const unresolvedTargets: Array<{ controllerIp: string; controllerName: string; targetHost: string; url: string }> = [];
        const nonMqttTargets = new Map<string, { ip: string; name: string; mqttEnabled: boolean; referencedBy: string[] }>();

        let checked = 0;
        let affectedControllers = 0;
        let updatedControllers = 0;
        let updatedUrls = 0;
        let skippedUrls = 0;

        type LocalNonMqttTarget = { ip: string; name: string; mqttEnabled: boolean; referencedBy: string[] };
        type ControllerRepairResult = {
            checked: number;
            affectedControllers: number;
            updatedControllers: number;
            updatedUrls: number;
            skippedUrls: number;
            unresolvedTargets: Array<{ controllerIp: string; controllerName: string; targetHost: string; url: string }>;
            nonMqttTargets: LocalNonMqttTarget[];
            failure?: { ip: string; name: string; reason: string };
        };
        type ControllerPhaseDiagnostic = {
            traceId: string;
            runId: string;
            ip: string;
            name: string;
            attempt: string;
            phase: "list" | "update" | "verify" | "reboot";
            ok: boolean;
            durationMs: number;
            detail?: string;
        };

        const diagnostics: ControllerPhaseDiagnostic[] = [];

        const mergeNonMqttTargets = (items: LocalNonMqttTarget[]) => {
            for (const item of items) {
                const key = `${item.ip}|${item.name}`;
                const existing = nonMqttTargets.get(key);
                if (existing) {
                    existing.referencedBy.push(...item.referencedBy);
                } else {
                    nonMqttTargets.set(key, {
                        ip: item.ip,
                        name: item.name,
                        mqttEnabled: item.mqttEnabled,
                        referencedBy: [...item.referencedBy],
                    });
                }
            }
        };

        const repairController = async (
            controller: IDevice,
            attemptLabel: string,
            tuning = rpcTuning
        ): Promise<ControllerRepairResult> => {
            const localUnresolvedTargets: Array<{ controllerIp: string; controllerName: string; targetHost: string; url: string }> = [];
            const localNonMqttTargets = new Map<string, LocalNonMqttTarget>();
            let localChecked = 0;
            let localAffectedControllers = 0;
            let localUpdatedControllers = 0;
            let localUpdatedUrls = 0;
            let localSkippedUrls = 0;
            const controllerIp = controller.ip || "";
            const controllerName = controller.name || "(unknown)";
            let phaseSeq = 0;

            const logPhase = (
                phase: "list" | "update" | "verify" | "reboot",
                startedAt: number,
                ok: boolean,
                detail?: string
            ) => {
                phaseSeq++;
                diagnostics.push({
                    traceId: `${runId}|${attemptLabel}|${controllerIp || "unknown"}|${phase}|${phaseSeq}`,
                    runId,
                    ip: controllerIp,
                    name: controllerName,
                    attempt: attemptLabel,
                    phase,
                    ok,
                    durationMs: Date.now() - startedAt,
                    detail,
                });
            };

            try {
                if (!controller.ip) {
                    return {
                        checked: localChecked,
                        affectedControllers: localAffectedControllers,
                        updatedControllers: localUpdatedControllers,
                        updatedUrls: localUpdatedUrls,
                        skippedUrls: localSkippedUrls,
                        unresolvedTargets: localUnresolvedTargets,
                        nonMqttTargets: [],
                        failure: { ip: "", name: controller.name || "(unknown)", reason: "Missing controller IP" },
                    };
                }

                const listStarted = Date.now();
                const webhookList = await shellyWebhookList(controller.ip, tuning);
                logPhase("list", listStarted, true);
                localChecked++;
                const hooks = webhookList?.result?.hooks ?? [];

                const hasRpc = hooks.some((hook) => (hook.urls ?? []).some((urlValue) => isRpcActionUrl(urlValue)));
                if (!hasRpc) {
                    return {
                        checked: localChecked,
                        affectedControllers: localAffectedControllers,
                        updatedControllers: localUpdatedControllers,
                        updatedUrls: localUpdatedUrls,
                        skippedUrls: localSkippedUrls,
                        unresolvedTargets: localUnresolvedTargets,
                        nonMqttTargets: [],
                    };
                }
                localAffectedControllers++;

                let controllerNeedsUpdate = false;

                for (const hook of hooks) {
                    const urls = hook.urls ?? [];
                    if (urls.length === 0) {
                        continue;
                    }

                    const nextUrls = [...urls];

                    for (let i = 0; i < urls.length; i++) {
                        const currentUrl = urls[i];
                        if (!isRpcActionUrl(currentUrl)) {
                            continue;
                        }

                        const targetHost = extractUrlHost(currentUrl);
                        const targetDevice = byIp.get(targetHost);

                        if (!targetDevice) {
                            localUnresolvedTargets.push({
                                controllerIp: controller.ip,
                                controllerName: controller.name || "(unknown)",
                                targetHost,
                                url: currentUrl,
                            });
                            localSkippedUrls++;
                            continue;
                        }

                        const mqttEnabled = Boolean(targetDevice.mqtt?.enable);
                        if (!mqttEnabled) {
                            const key = `${targetDevice.ip}|${targetDevice.name}`;
                            const existing = localNonMqttTargets.get(key);
                            if (existing) {
                                existing.referencedBy.push(`${controller.name || "(unknown)"} (${controller.ip})`);
                            } else {
                                localNonMqttTargets.set(key, {
                                    ip: targetDevice.ip,
                                    name: targetDevice.name || "(unknown)",
                                    mqttEnabled,
                                    referencedBy: [`${controller.name || "(unknown)"} (${controller.ip})`],
                                });
                            }
                            localSkippedUrls++;
                            continue;
                        }

                        const roomId = Number(targetDevice.device?.room_id ?? 0);
                        const targetName = targetDevice.name || targetDevice.device?.name || "target";
                        const targetClientName = String(targetDevice.device?.id ?? targetDevice.ip);

                        nextUrls[i] = buildManagedToggleUrl(webhookHost, siteConfig.name || "site", roomId, targetName, targetClientName);
                        if (nextUrls[i] !== currentUrl) {
                            controllerNeedsUpdate = true;
                            localUpdatedUrls++;
                        }
                    }

                    if (!controllerNeedsUpdate) {
                        continue;
                    }

                    const updateBody = {
                        id: 0,
                        method: "Webhook.Update",
                        params: {
                            id: hook.id,
                            cid: hook.cid,
                            enable: hook.enable,
                            event: hook.event,
                            name: hook.name,
                            ssl_ca: hook.ssl_ca,
                            urls: nextUrls,
                            condition: hook.condition,
                            repeat_period: hook.repeat_period,
                        } as Hook,
                    };

                    const updateStarted = Date.now();
                    const updateResult = await postRequest<Record<string, unknown>>(
                        `http://${controller.ip}/rpc/`,
                        {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "User-Agent": "ShellyApp/1.0",
                            Connection: tuning.connectionHeader,
                        },
                        updateBody,
                        tuning.retries,
                        tuning.delayMs,
                        tuning.timeoutMs
                    );

                    if (isRpcError(updateResult)) {
                        logPhase("update", updateStarted, false, updateResult.error?.message || "Webhook.Update RPC error");
                        const message = updateResult.error?.message || "Webhook.Update RPC error";
                        throw new Error(message);
                    }

                    logPhase("update", updateStarted, true);
                }

                if (controllerNeedsUpdate) {
                    const verifyStarted = Date.now();
                    const verify = await shellyWebhookList(controller.ip, tuning);
                    const remainingRpc = (verify?.result?.hooks ?? []).some((hook) => (hook.urls ?? []).some((urlValue) => isRpcActionUrl(urlValue)));
                    logPhase("verify", verifyStarted, !remainingRpc, remainingRpc ? "RPC URLs still present after update" : undefined);
                    if (!remainingRpc) {
                        localUpdatedControllers++;
                        const rebootStarted = Date.now();
                        const rebootResult = await shellyReboot(controller.ip, tuning);
                        logPhase("reboot", rebootStarted, Boolean(rebootResult), rebootResult ? undefined : "Reboot did not complete cleanly");
                        if (!rebootResult) {
                            logger.warn(`[server]: Webhook repair verified for ${controller.ip}, but reboot did not complete cleanly`);
                        }
                    }
                }

                return {
                    checked: localChecked,
                    affectedControllers: localAffectedControllers,
                    updatedControllers: localUpdatedControllers,
                    updatedUrls: localUpdatedUrls,
                    skippedUrls: localSkippedUrls,
                    unresolvedTargets: localUnresolvedTargets,
                    nonMqttTargets: Array.from(localNonMqttTargets.values()),
                };
            } catch (error: Error | any) {
                const message = error?.message || "Unknown error";
                if (!diagnostics.some((d) => d.ip === controllerIp && d.name === controllerName && d.attempt === attemptLabel && !d.ok)) {
                    diagnostics.push({
                        traceId: `${runId}|${attemptLabel}|${controllerIp || "unknown"}|list|terminal`,
                        runId,
                        ip: controllerIp,
                        name: controllerName,
                        attempt: attemptLabel,
                        phase: "list",
                        ok: false,
                        durationMs: 0,
                        detail: message,
                    });
                }
                return {
                    checked: localChecked,
                    affectedControllers: localAffectedControllers,
                    updatedControllers: localUpdatedControllers,
                    updatedUrls: localUpdatedUrls,
                    skippedUrls: localSkippedUrls,
                    unresolvedTargets: localUnresolvedTargets,
                    nonMqttTargets: Array.from(localNonMqttTargets.values()),
                    failure: {
                        ip: controller.ip || "",
                        name: controller.name || "(unknown)",
                        reason: message,
                    },
                };
            }
        };

        const aggregateResult = (result: ControllerRepairResult) => {
            checked += result.checked;
            affectedControllers += result.affectedControllers;
            updatedControllers += result.updatedControllers;
            updatedUrls += result.updatedUrls;
            skippedUrls += result.skippedUrls;
            unresolvedTargets.push(...result.unresolvedTargets);
            mergeNonMqttTargets(result.nonMqttTargets);
            if (result.failure) {
                failures.push(result.failure);
            }
        };

        for (let i = 0; i < selectedControllers.length; i += pacing.controllerBatchSize) {
            const batch = selectedControllers.slice(i, i + pacing.controllerBatchSize);
            const batchResults = await Promise.all(
                batch.map(async (controller, index) => {
                    const jitter = Math.floor(Math.random() * pacing.interControllerJitterMs);
                    await sleep(index * pacing.interControllerDelayMs + jitter);
                    return repairController(controller, "first_pass");
                })
            );

            for (const result of batchResults) {
                aggregateResult(result);
            }

            if (i + pacing.controllerBatchSize < selectedControllers.length) {
                await sleep(pacing.betweenBatchDelayMs);
            }
        }

        const firstPassFailures = [...failures];
        const retainedFailures: Array<{ ip: string; name: string; reason: string }> = [];
        failures.length = 0;
        let secondPassAttempted = 0;
        let secondPassRecovered = 0;

        for (const failed of firstPassFailures) {
            if (!failed.ip || !transientRetryPattern.test(failed.reason)) {
                retainedFailures.push(failed);
                continue;
            }

            const controller = selectedControllers.find((device) => device.ip === failed.ip);
            if (!controller) {
                retainedFailures.push(failed);
                continue;
            }

            secondPassAttempted++;
            await sleep(1000 + Math.floor(Math.random() * 750));
            const retryResult = await repairController(controller, "second_pass", rpcTuning);

            // Keep top-line counts stable to the first pass and use retry only
            // for recovery from transient transport failures.
            unresolvedTargets.push(...retryResult.unresolvedTargets);
            mergeNonMqttTargets(retryResult.nonMqttTargets);

            if (retryResult.failure) {
                retainedFailures.push(retryResult.failure);
                continue;
            }

            secondPassRecovered++;
            updatedControllers += retryResult.updatedControllers;
        }

        const secondPassFailures = [...retainedFailures];
        const finalFailures: Array<{ ip: string; name: string; reason: string }> = [];
        let thirdPassAttempted = 0;
        let thirdPassRecovered = 0;

        for (const failed of secondPassFailures) {
            if (!failed.ip || !transientRetryPattern.test(failed.reason)) {
                finalFailures.push(failed);
                continue;
            }

            const controller = selectedControllers.find((device) => device.ip === failed.ip);
            if (!controller) {
                finalFailures.push(failed);
                continue;
            }

            thirdPassAttempted++;
            await sleep(2500 + Math.floor(Math.random() * 1200));
            const thirdResult = await repairController(controller, "third_pass", thirdPassTuning);

            unresolvedTargets.push(...thirdResult.unresolvedTargets);
            mergeNonMqttTargets(thirdResult.nonMqttTargets);

            if (thirdResult.failure) {
                finalFailures.push(thirdResult.failure);
                continue;
            }

            thirdPassRecovered++;
            updatedControllers += thirdResult.updatedControllers;
        }

        failures.push(...finalFailures);

        repairRpcRunHistory.set(runId, {
            createdAt: new Date().toISOString(),
            diagnostics,
            failures,
            retry: {
                secondPassAttempted,
                secondPassRecovered,
                thirdPassAttempted,
                thirdPassRecovered,
            },
        });
        repairRpcRunOrder.push(runId);
        while (repairRpcRunOrder.length > MAX_REPAIR_RPC_HISTORY) {
            const evictedRunId = repairRpcRunOrder.shift();
            if (evictedRunId) {
                repairRpcRunHistory.delete(evictedRunId);
            }
        }

        res.json({
            runId,
            webhookHost,
            inferredWebhookHost: siteConfig.webhook.trim() ? "" : webhookHost,
            total: selectedControllers.length,
            requestedControllerIps,
            skippedRequestedIps,
            checked,
            affectedControllers,
            updatedControllers,
            updatedUrls,
            skippedUrls,
            unresolvedTargets,
            nonMqttTargets: Array.from(nonMqttTargets.values()).map((entry) => ({
                ...entry,
                referencedBy: Array.from(new Set(entry.referencedBy)),
            })),
            retry: {
                secondPassAttempted,
                secondPassRecovered,
                thirdPassAttempted,
                thirdPassRecovered,
                transientPattern: transientRetryPattern.source,
                pacing,
                thirdPassTuning,
            },
            diagnostics,
            failed: failures.length,
            failures,
        });
    } catch (error) {
        logger.error(`[server]: Failed to repair RPC webhook URLs: ${error}`);
        res.status(500).json({ error: "Failed to repair RPC webhook URLs" });
    } finally {
        repairRpcInFlight = false;
    }
});

shellyRouter.get("/devices/webhooks/repair-rpc/failed-diagnostics", (req: Request, res: Response) => {
    const runId = String(req.query.runId || "").trim() || repairRpcRunOrder[repairRpcRunOrder.length - 1] || "";
    if (!runId) {
        res.status(404).json({ error: "No repair-rpc run history found" });
        return;
    }

    const run = repairRpcRunHistory.get(runId);
    if (!run) {
        res.status(404).json({ error: `Run not found: ${runId}` });
        return;
    }

    const limitRaw = String(req.query.limit || "50");
    const parsedLimit = Number(limitRaw);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50;

    const failedDiagnostics = run.diagnostics.filter((item) => !item.ok).slice(0, limit);

    res.json({
        runId,
        createdAt: run.createdAt,
        failedCount: failedDiagnostics.length,
        totalFailures: run.failures.length,
        retry: run.retry,
        failures: run.failures,
        diagnostics: failedDiagnostics,
    });
});

shellyRouter.post("/devices/webhooks/remove-invalid-host-actions", async (req: Request, res: Response) => {
    const rpcTuning = {
        retries: 5,
        delayMs: 1200,
        timeoutMs: 10000,
        connectionHeader: "close" as const,
    };

    const dryRun = Boolean(req.body?.dryRun);
    const requestedControllerIps = Array.isArray(req.body?.controllerIps)
        ? req.body.controllerIps.map((value: unknown) => String(value || "").trim()).filter((value: string) => value !== "")
        : [];

    try {
        const storedDevices = await getStoredIDevices();
        const byIp = new Map(storedDevices.filter((d) => Boolean(d.ip)).map((d) => [d.ip, d]));
        const requestFilter = requestedControllerIps.length > 0 ? new Set(requestedControllerIps) : null;
        const selectedControllers = requestFilter
            ? storedDevices.filter((device) => Boolean(device.ip) && requestFilter.has(device.ip))
            : storedDevices;
        const skippedRequestedIps = requestFilter
            ? requestedControllerIps.filter((ip: string) => !selectedControllers.some((device) => device.ip === ip))
            : [];

        let checked = 0;
        let affectedControllers = 0;
        let updatedControllers = 0;
        let removedActions = 0;

        const failures: Array<{ ip: string; name: string; reason: string }> = [];
        const removals: Array<{ controllerIp: string; controllerName: string; hookId: number; removedUrl: string; targetHost: string }> = [];

        for (const controller of selectedControllers) {
            try {
                if (!controller.ip) {
                    failures.push({ ip: "", name: controller.name || "(unknown)", reason: "Missing controller IP" });
                    continue;
                }

                const webhookList = await shellyWebhookList(controller.ip, rpcTuning);
                checked++;
                const hooks = webhookList?.result?.hooks ?? [];

                let controllerNeedsUpdate = false;
                let controllerAppliedUpdate = false;
                let controllerRemovedApplied = 0;

                for (const hook of hooks) {
                    const urls = hook.urls ?? [];
                    if (urls.length === 0) {
                        continue;
                    }

                    const nextUrls: string[] = [];
                    let hookRemovedCount = 0;
                    const hookRemovals: Array<{ controllerIp: string; controllerName: string; hookId: number; removedUrl: string; targetHost: string }> = [];

                    for (const urlValue of urls) {
                        if (!isRpcActionUrl(urlValue)) {
                            nextUrls.push(urlValue);
                            continue;
                        }

                        const targetHost = extractUrlHost(urlValue);
                        const isInvalidHost = !targetHost || !byIp.has(targetHost);

                        if (!isInvalidHost) {
                            nextUrls.push(urlValue);
                            continue;
                        }

                        hookRemovedCount++;
                        hookRemovals.push({
                            controllerIp: controller.ip,
                            controllerName: controller.name || "(unknown)",
                            hookId: Number(hook.id),
                            removedUrl: urlValue,
                            targetHost,
                        });
                    }

                    if (hookRemovedCount === 0) {
                        continue;
                    }

                    controllerNeedsUpdate = true;

                    if (dryRun) {
                        removedActions += hookRemovedCount;
                        removals.push(...hookRemovals);
                        continue;
                    }

                    const rpcBody = nextUrls.length === 0
                        ? {
                            id: 0,
                            method: "Webhook.Delete",
                            params: {
                                id: hook.id,
                            },
                        }
                        : {
                            id: 0,
                            method: "Webhook.Update",
                            params: {
                                id: hook.id,
                                cid: hook.cid,
                                enable: hook.enable,
                                event: hook.event,
                                name: hook.name,
                                ssl_ca: hook.ssl_ca,
                                urls: nextUrls,
                                condition: hook.condition,
                                repeat_period: hook.repeat_period,
                            } as Hook,
                        };

                    const updateResult = await postRequest<Record<string, unknown>>(
                        `http://${controller.ip}/rpc/`,
                        {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "User-Agent": "ShellyApp/1.0",
                            Connection: rpcTuning.connectionHeader,
                        },
                        rpcBody,
                        rpcTuning.retries,
                        rpcTuning.delayMs,
                        rpcTuning.timeoutMs
                    );

                    if (isRpcError(updateResult)) {
                        const message = updateResult.error?.message || "Webhook.Update RPC error";
                        throw new Error(message);
                    }

                    controllerAppliedUpdate = true;
                    controllerRemovedApplied += hookRemovedCount;
                    removals.push(...hookRemovals);
                }

                if (controllerNeedsUpdate) {
                    affectedControllers++;
                    if (!dryRun && controllerAppliedUpdate) {
                        updatedControllers++;
                        removedActions += controllerRemovedApplied;
                    }
                }
            } catch (error: Error | any) {
                failures.push({
                    ip: controller.ip || "",
                    name: controller.name || "(unknown)",
                    reason: error?.message || "Unknown error",
                });
            }
        }

        res.json({
            dryRun,
            total: selectedControllers.length,
            requestedControllerIps,
            skippedRequestedIps,
            checked,
            affectedControllers,
            updatedControllers,
            removedActions,
            failed: failures.length,
            failures,
            removals,
        });
    } catch (error) {
        logger.error(`[server]: Failed to remove invalid-host webhook actions: ${error}`);
        res.status(500).json({ error: "Failed to remove invalid-host webhook actions" });
    }
});

shellyRouter.post("/:ip/mqtt", async (req: Request, res: Response) => {
    logger.info(`[server]: Activating MQTT for device with IP: ${req.params.ip}`);
    const ip = req.params.ip;
    const device: IDevice = req.body.device;
    const server: string | undefined = req.body.server;
    const topicPrefix: string | undefined = req.body.topicPrefix;
    const applyManagedActions = req.body.applyManagedActions !== false;

    // Fail fast before changing MQTT config if we cannot reliably enforce
    // detached mode for relay devices.
    if (applyManagedActions) {
        const detachedAssessment = await ensureDetachedMode(ip, 3);
        const detachedReady = detachedAssessment.verified || (await canUseDetachedFallback(ip, detachedAssessment, true, false));
        if (!detachedReady) {
            logger.error(`[server]: Failed pre-MQTT detached verification for ${ip}; aborting MQTT enable. ${JSON.stringify(detachedAssessment)}`);
            res.status(502).json({ error: "Failed to set detached mode before enabling MQTT. Please retry." });
            return;
        }

        if (!detachedAssessment.verified) {
            logger.warn(`[server]: Proceeding with MQTT enable for ${ip} using detached fallback due transport instability. ${JSON.stringify(detachedAssessment)}`);
        }

        // Configure toggle edge actions before enabling MQTT/reboot so the
        // device is fully prepared before the disruptive step.
        const hasWebhookContext = Boolean(device?.room?.id) && Boolean(device?.device?.id);
        if (!hasWebhookContext) {
            logger.error(`[server]: Missing webhook context for ${ip}; room id or device id not provided.`);
            res.status(400).json({ error: "Missing room/device context required to apply managed toggle actions." });
            return;
        }

        await replaceManagedToggleHooks(ip);

        const webhook = await Promise.all([
            shellyActivateWebhook(ip, device, "on"),
            shellyActivateWebhook(ip, device, "off"),
        ]);
        logger.info(`[server]: Managed webhook activation response for ${ip}: ${JSON.stringify(webhook)}`);

        const webhookFailures = webhook
            .map((result, index) => {
                if (!result) {
                    return index === 0 ? "input.toggle_on hook was not created" : "input.toggle_off hook was not created";
                }
                if (isRpcError(result)) {
                    return result.error?.message || "Webhook RPC error";
                }
                return "";
            })
            .filter((message) => message !== "");

        if (webhookFailures.length > 0) {
            logger.error(`[server]: Failed to apply managed toggle actions for ${ip}: ${webhookFailures.join("; ")}`);
            res.status(502).json({ error: "Failed to apply managed toggle actions before enabling MQTT." });
            return;
        }
    }

    const mqtt = await shellyActivateMqtt(ip, device, { server, topicPrefix });
    logger.info(`[server]: MQTT activation response for ${ip}: ${JSON.stringify(mqtt)}`);
    if (mqtt) {
        await shellyReboot(ip);
        let postRebootVerificationSkipped = false;

        if (applyManagedActions) {
            const rpcReady = await waitForRpcReady(ip, 18, 1500);
            if (!rpcReady) {
                logger.warn(`[server]: Device ${ip} did not come back online after reboot during MQTT enable flow; returning success with verification warning.`);
                postRebootVerificationSkipped = true;
            } else {
                const detachedAssessment = await ensureDetachedMode(ip, 6);
                const detachedReady = detachedAssessment.verified || (await canUseDetachedFallback(ip, detachedAssessment, false, true));
                if (!detachedReady) {
                    logger.error(`[server]: Failed to verify detached mode for ${ip} after MQTT enable. ${JSON.stringify(detachedAssessment)}`);
                    res.status(502).json({ error: "MQTT enabled, but failed to set detached mode after retries. Please retry once." });
                    return;
                }

                if (!detachedAssessment.verified) {
                    logger.warn(`[server]: Post-MQTT detached fallback accepted for ${ip}. ${JSON.stringify(detachedAssessment)}`);
                }
            }
        }

        mqtt.webhooks = await shellyWebhookList(ip) || undefined;
        if (postRebootVerificationSkipped) {
            (mqtt as IDevice & { verificationWarning?: string }).verificationWarning = "Device did not respond after reboot; MQTT enable likely applied but detached verification was skipped.";
        }
        await saveDiscoveredDevices([mqtt]);

        mqttClient.status(mqtt.device);
    } else {
        res.status(404).send("Shelly device not found");
        return;
    }

    res.send(mqtt);
});

shellyRouter.post("/:ip/webhook", async (req: Request, res: Response) => {
    logger.info(`[server]: Activating Webhook for device with IP: ${req.params.ip}`, req.body.device);
    const ip = req.params.ip;
    const device: IDevice = req.body.device;

    const webhook = await Promise.all([
        shellyActivateWebhook(ip, device, "on"),
        shellyActivateWebhook(ip, device, "off")
    ]);

    logger.info(`[server]: Webhook activation response for ${ip}: ${JSON.stringify(webhook)}`);
    if (webhook && webhook.length === 2) {
        await shellyReboot(ip);

        if (device) {
            device.webhooks = await shellyWebhookList(device.ip) || undefined;
            mqttClient.status(device.device);
        }
    } else {
        res.status(404).send("Shelly device not found");
    }

    res.send(device);
});

shellyRouter.post("/:ip/companion", async (req: Request, res: Response) => {
    const ip = req.params.ip;
    const targetIp: string = (req.body.targetIp || "").trim();
    const inputId = Number(req.body.inputId ?? 0);
    const detach = req.body.detach !== false; // default true

    if (targetIp === "") {
        res.status(400).json({ error: "targetIp is required" });
        return;
    }
    if (!Number.isInteger(inputId) || inputId < 0) {
        res.status(400).json({ error: "inputId must be a non-negative integer" });
        return;
    }
    if (targetIp === ip) {
        res.status(400).json({ error: "targetIp must be a different device" });
        return;
    }

    // Resolve the target's authoritative name + room from stored devices so the
    // webhook points at a stable MQTT topic (site/room/name/switch) instead of
    // the target's IP, which is DHCP-assigned and can change.
    const storedDevices = await getStoredIDevices();
    const target = storedDevices.find((d) => d.ip === targetIp);
    if (!target || !target.room?.id) {
        res.status(404).json({ error: "Target device not found or has no room. Re-run a scan and set its room first." });
        return;
    }
    if (!target.mqtt?.enable) {
        res.status(400).json({ error: "Target device must have MQTT enabled before linking." });
        return;
    }

    logger.info(`[server]: Linking companion ${ip} input ${inputId} -> ${target.name} (room ${target.room.id}, detach=${detach})`);

    if (detach) {
        await shellyDetachInput(ip, inputId);
    }
    // Clear any prior hooks to the same target so re-linking stays idempotent.
    await shellyDeleteCompanionWebhooks(ip, target.name);
    const on = await shellyActivateCompanionWebhook(ip, target.name, target.room.id, "on", inputId);
    const off = await shellyActivateCompanionWebhook(ip, target.name, target.room.id, "off", inputId);

    if (!on || !off) {
        res.status(502).json({ error: "Failed to install companion webhooks on the device" });
        return;
    }

    const webhooks = await shellyWebhookList(ip);
    const source = storedDevices.find((d) => d.ip === ip);
    if (source) {
        source.webhooks = webhooks || undefined;
        await saveDiscoveredDevices([source]);
    }
    res.json({ ip, targetIp, targetName: target.name, targetRoomId: target.room.id, inputId, detach, webhooks });
});

shellyRouter.post("/:ip/wifi", async (req: Request, res: Response) => {
    const ip = req.params.ip;
    const ssid: string = (req.body.ssid || "").trim();
    let password: string | undefined = req.body.password;

    if (ssid === "") {
        res.status(400).json({ error: "ssid is required" });
        return;
    }

    // If no password is supplied, use the stored credential for this SSID.
    if (password === undefined || password === "") {
        const stored = await getWifiCredentialBySsid(ssid);
        if (!stored) {
            res.status(400).json({ error: `No stored WiFi credential for SSID "${ssid}". Provide a password.` });
            return;
        }
        password = stored.password;
    }

    logger.info(`[server]: Changing WiFi for device with IP: ${ip} to SSID: ${ssid}`);
    const result = await shellySetWifi(ip, ssid, password);

    if (result) {
        // Reboot so the device reconnects on the new network. It will get a new
        // IP on the target subnet, so it becomes unreachable at this IP.
        await shellyReboot(ip);
        res.send({ ip, ssid, ...result });
    } else {
        res.status(404).send("Shelly device not found");
    }
});
