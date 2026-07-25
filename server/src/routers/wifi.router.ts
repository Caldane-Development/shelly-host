import { Router, Request, Response } from "express";
import { logger } from "../logger";
import { deleteWifiCredential, getWifiCredentials, saveWifiCredential } from "../utils/wifi.helper";

export const wifiRouter = Router();

wifiRouter.get("/", async (_req: Request, res: Response) => {
    try {
        const credentials = await getWifiCredentials();
        res.json(credentials);
    } catch (error) {
        logger.error(`[wifi]: Failed to fetch credentials: ${error}`);
        res.status(500).json({ error: "Failed to fetch WiFi credentials" });
    }
});

wifiRouter.post("/", async (req: Request, res: Response) => {
    const { ssid, password } = req.body ?? {};

    if (typeof ssid !== "string" || ssid.trim() === "" || typeof password !== "string" || password === "") {
        res.status(400).json({ error: "ssid and password are required" });
        return;
    }

    try {
        const saved = await saveWifiCredential(ssid.trim(), password);
        res.status(201).json(saved);
    } catch (error) {
        logger.error(`[wifi]: Failed to save credential: ${error}`);
        res.status(500).json({ error: "Failed to save WiFi credential" });
    }
});

wifiRouter.delete("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid id" });
        return;
    }

    try {
        await deleteWifiCredential(id);
        res.sendStatus(204);
    } catch (error) {
        logger.error(`[wifi]: Failed to delete credential: ${error}`);
        res.status(500).json({ error: "Failed to delete WiFi credential" });
    }
});
