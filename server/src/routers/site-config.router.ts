import { Router, Request, Response } from "express";
import { logger } from "../logger";
import { getSiteConfig, saveSiteConfig } from "../utils/site-config.helper";
import site from "../assets/json/site.json";

export const siteConfigRouter = Router();

// Never expose the raw cloud auth key over the API. Return a masked hint so the
// UI can show whether it is set without leaking the secret.
const maskCloudAuthKey = (key: string): string => {
    if (!key) {
        return "";
    }
    return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
};

siteConfigRouter.get("/", async (_req: Request, res: Response) => {
    try {
        const config = await getSiteConfig();
        res.json({ ...config, cloudAuthKey: maskCloudAuthKey(config.cloudAuthKey) });
    } catch (error) {
        logger.error(`[site-config]: Failed to fetch site config: ${error}`);
        res.status(500).json({ error: "Failed to fetch site config" });
    }
});

siteConfigRouter.put("/", async (req: Request, res: Response) => {
    const { name, description, mqtt, webhook, street, city, state, zip, cloudAuthKey } = req.body ?? {};

    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
        res.status(400).json({ error: "name must be a non-empty string" });
        return;
    }

    try {
        const saved = await saveSiteConfig({
            ...(name !== undefined ? { name: name.trim() } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(mqtt !== undefined ? { mqtt } : {}),
            ...(webhook !== undefined ? { webhook } : {}),
            ...(street !== undefined ? { street } : {}),
            ...(city !== undefined ? { city } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(zip !== undefined ? { zip } : {}),
            ...(cloudAuthKey !== undefined ? { cloudAuthKey } : {}),
        });
        res.json({ ...saved, cloudAuthKey: maskCloudAuthKey(saved.cloudAuthKey) });
    } catch (error) {
        logger.error(`[site-config]: Failed to save site config: ${error}`);
        res.status(500).json({ error: "Failed to save site config" });
    }
});

// The catalog of logical switches per room, sourced from site.json. Used by the
// device "enable MQTT" dialog to let a device mirror an existing switch topic
// (e.g. two relays controlling the same light in a 3-way setup).
siteConfigRouter.get("/rooms", (_req: Request, res: Response) => {
    const rooms = Object.values(site.buffington.rooms ?? {}).map((room) => ({
        name: room.name,
        description: (room as { description?: string }).description ?? "",
        switches: (room.switches ?? []).map((sw) => ({
            name: sw.name,
            description: sw.description ?? "",
        })),
    }));
    res.json(rooms);
});

export default siteConfigRouter;
