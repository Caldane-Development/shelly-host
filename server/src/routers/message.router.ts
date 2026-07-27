import { Router } from "express";
import { Request, Response } from "express";
import { logger } from "../logger";
import { createMqttConfig, getMqttMonitorStatus, mqtt, mqttAddMonitor, mqttRemoveMonitor } from "../utils/mqtt.helper";
import { channelDictionary } from "../utils/channel.helper";
import roomList from "../assets/json/room-list.json";

export const messageRouter = Router();

messageRouter.get("/", (_: Request, res: Response) => {
    res.send("<h1>MQTT Server</h1><p>Use /channel/:channel/message/:message/:clientName to send a message to a channel</p>");
});

messageRouter.get("/monitor", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    // Keep SSE alive through proxies/load balancers that close idle streams.
    const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
    }, 15000);

    const monitorId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    logger.info(`[server]: MQTT monitor connected: ${monitorId}`);

    mqttAddMonitor(monitorId, (message) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
    });

    req.on("close", () => {
        clearInterval(heartbeat);
        mqttRemoveMonitor(monitorId);
        logger.info(`[server]: MQTT monitor disconnected: ${monitorId}`);
    });
});

messageRouter.get("/monitor/status", (_req: Request, res: Response) => {
    res.json(getMqttMonitorStatus());
});

messageRouter.post("/client/:clientName", (req: Request, res: Response) => {
    const { clientName } = req.params;
    const message: string = req.body.message;
    const mqttChannel: string = req.body.channel;
    if (!mqttChannel) {
        res.status(404).send("Channel not found");
        return;
    }
    logger.request(`[server]: Publish mqtt message: ${message} \n    ${clientName}`);
    mqtt.publish(clientName, mqttChannel, JSON.stringify(message));
    res.sendStatus(204);
});

messageRouter.get("/srd/:siteName/:roomId/:deviceName/switch/message/:message/:clientName", (req: Request, res: Response) => {
    const siteName = req.params.siteName.toLocaleLowerCase();
    const roomId = req.params.roomId as keyof typeof roomList.data.rooms;
    if (!roomId) {
        res.status(404).send("Room ID not found");
        return;
    }
    const room = roomList.data.rooms[roomId];
    if (!room) {
        res.status(404).send("Room not found");
        return;
    }
    const deviceName = req.params.deviceName.toLocaleLowerCase();
    const clientName = req.params.clientName.toLocaleLowerCase();
    const message = JSON.stringify({
        id: deviceName,
        src: `${siteName}.action`,
        method: "Switch.Toggle",
        params: { id: 0 },
    });

    const mqttConfig = createMqttConfig(deviceName, room);
    const mqttChannel: string = mqttConfig.topic_prefix;
    if (mqttChannel.split("/").filter((part) => part.trim()).length < 4) {
        res.status(400).send("Could not compose channel");
        return;
    }

    logger.request(`[server]: Publish mqtt message: ${mqttChannel} - ${message}`);
    mqtt.publish(clientName, mqttChannel, message);
    res.sendStatus(204);
});

messageRouter.get("/channel/:channel/message/:message/:clientName", (req: Request, res: Response) => {
    const mqttChannel: string = channelDictionary[req.params.channel as keyof typeof channelDictionary];
    const { clientName, message, channel } = req.params;
    if (!mqttChannel) {
        res.status(404).send("Channel not found");
        return;
    }
    logger.request(`[server]: Publish mqtt message: ${mqttChannel} \n    ${message}`);
    mqtt.publish(clientName, mqttChannel, message);
    res.sendStatus(204);
});
