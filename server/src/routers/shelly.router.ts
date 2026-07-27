import { Router } from "express";
import { Request, Response } from "express";
import deviceList from "../assets/json/device-list.json";
import roomList from "../assets/json/room-list.json";
import config from "../assets/json/config.json";
import { logger } from "../logger";
import os from "os";
import { composeShellyDevice, discoverShelly, shellyActivateMqtt, shellyActivateWebhook, shellyCloudDevices, shellyCloudRooms, shellyGetMqttSettings, shellyReboot, shellySetWifi, shellyWebhookList, shellyActivateCompanionWebhook, shellyDeleteCompanionWebhooks, shellyDetachInput } from "../utils/discovery.helper";
import { MqttResponse } from "../../../common/models/mqtt.interface";
import { DeviceList, IDevice } from "../../../common/models/device.interface";
import { mqttAddListener, mqtt as mqttClient } from "../utils/mqtt.helper";
import { getStoredDevices, getStoredIDevices, getEnabledDevices, saveDiscoveredDevices } from "../utils/device.helper";
import { getStoredRooms, saveDiscoveredRooms } from "../utils/room.helper";
import { getWifiCredentialBySsid } from "../utils/wifi.helper";
import { getSiteConfigCached } from "../utils/site-config.helper";

export const shellyRouter = Router();

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

shellyRouter.post("/:ip/mqtt", async (req: Request, res: Response) => {
    logger.info(`[server]: Activating MQTT for device with IP: ${req.params.ip}`);
    const ip = req.params.ip;
    const device: IDevice = req.body.device;
    const server: string | undefined = req.body.server;
    const topicPrefix: string | undefined = req.body.topicPrefix;

    const mqtt = await shellyActivateMqtt(ip, device, { server, topicPrefix });
    logger.info(`[server]: MQTT activation response for ${ip}: ${JSON.stringify(mqtt)}`);
    if (mqtt) {
        await shellyReboot(ip);

        await saveDiscoveredDevices([mqtt]);

        mqttClient.status(mqtt.device);
    } else {
        res.status(404).send("Shelly device not found");
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
