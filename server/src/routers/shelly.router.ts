import { Router } from "express";
import { Request, Response } from "express";
import deviceList from "../assets/json/device-list.json";
import roomList from "../assets/json/room-list.json";
import config from "../assets/json/config.json";
import { logger } from "../logger";
import os from "os";
import { composeShellyDevice, discoverShelly, shellyActivateMqtt, shellyActivateWebhook, shellyGetMqttSettings, shellyReboot, shellyWebhookList } from "../utils/discovery.helper";
import { MqttResponse } from "../../../common/models/mqtt.interface";
import { DeviceList, IDevice } from "../../../common/models/device.interface";
import { mqttAddListener, mqtt as mqttClient } from "../utils/mqtt.helper";
import { getStoredDevices, getStoredIDevices, getEnabledDevices, saveDiscoveredDevices } from "../utils/device.helper";
import { getStoredRooms, saveDiscoveredRooms } from "../utils/room.helper";

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
    // const shellyRooms = await shellyCloudRooms();
    // await new Promise((resolve) => setTimeout(resolve, 5000)); // Adding a delay to ensure the cloud rooms are fetched before discovering devices
    // const shellyDevices = await shellyCloudDevices();
    const shellyRooms = roomList;
    const shellyDevices: DeviceList = deviceList;
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
