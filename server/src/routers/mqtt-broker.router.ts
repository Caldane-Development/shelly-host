import { Router, Request, Response } from "express";
import { logger } from "../logger";
import { deleteMqttBroker, getAvailableBrokers, getMqttBrokers, saveMqttBroker } from "../utils/mqtt-broker.helper";

export const mqttBrokerRouter = Router();

mqttBrokerRouter.get("/", async (_req: Request, res: Response) => {
    try {
        const brokers = await getMqttBrokers();
        res.json(brokers);
    } catch (error) {
        logger.error(`[mqtt-broker]: Failed to fetch brokers: ${error}`);
        res.status(500).json({ error: "Failed to fetch MQTT brokers" });
    }
});

mqttBrokerRouter.get("/available", async (_req: Request, res: Response) => {
    try {
        const servers = await getAvailableBrokers();
        res.json(servers);
    } catch (error) {
        logger.error(`[mqtt-broker]: Failed to fetch available brokers: ${error}`);
        res.status(500).json({ error: "Failed to fetch available brokers" });
    }
});

mqttBrokerRouter.post("/", async (req: Request, res: Response) => {
    const { server, username, password } = req.body ?? {};

    if (typeof server !== "string" || server.trim() === "") {
        res.status(400).json({ error: "server is required" });
        return;
    }

    try {
        const saved = await saveMqttBroker(
            server.trim(),
            typeof username === "string" ? username.trim() : "",
            typeof password === "string" ? password : ""
        );
        res.status(201).json(saved);
    } catch (error) {
        logger.error(`[mqtt-broker]: Failed to save broker: ${error}`);
        res.status(500).json({ error: "Failed to save MQTT broker" });
    }
});

mqttBrokerRouter.delete("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid id" });
        return;
    }

    try {
        await deleteMqttBroker(id);
        res.sendStatus(204);
    } catch (error) {
        logger.error(`[mqtt-broker]: Failed to delete broker: ${error}`);
        res.status(500).json({ error: "Failed to delete MQTT broker" });
    }
});
