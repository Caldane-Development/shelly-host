import { Router, Request, Response } from "express";
import { getBridges, createBridge, deleteBridge } from "../utils/bridge.helper";

export const bridgeRouter = Router();

bridgeRouter.get("/", async (_req: Request, res: Response) => {
    try {
        res.json(await getBridges());
    } catch (error) {
        res.status(500).send(String(error));
    }
});

bridgeRouter.post("/", async (req: Request, res: Response) => {
    const { controllerDeviceId, targetDeviceId, controllerChannel, targetChannel } = req.body ?? {};
    if (!controllerDeviceId || !targetDeviceId) {
        return res.status(400).send("controllerDeviceId and targetDeviceId are required");
    }
    try {
        const bridge = await createBridge(
            String(controllerDeviceId),
            String(targetDeviceId),
            Number(controllerChannel ?? 0) || 0,
            Number(targetChannel ?? 0) || 0
        );
        res.status(201).json(bridge);
    } catch (error) {
        res.status(500).send(String(error));
    }
});

bridgeRouter.delete("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid bridge id");
    }
    await deleteBridge(id);
    res.sendStatus(204);
});
