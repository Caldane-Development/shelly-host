import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { devices as devicesTable } from "../db/schema";
import {
    getGroups,
    getGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    setMembers,
    triggerGroup,
} from "../utils/group.helper";
import { shellyActivateGroupWebhook, shellyDeleteGroupWebhooks } from "../utils/discovery.helper";

export const groupRouter = Router();

groupRouter.get("/", async (_req: Request, res: Response) => {
    try {
        res.json(await getGroups());
    } catch (error) {
        res.status(500).send(String(error));
    }
});

groupRouter.get("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    const group = await getGroup(id);
    if (!group) {
        return res.status(404).send("Group not found");
    }
    res.json(group);
});

groupRouter.post("/", async (req: Request, res: Response) => {
    const { name, roomId, controllerDeviceId, tieBreak, memberDeviceIds } = req.body ?? {};
    if (!name || String(name).trim() === "") {
        return res.status(400).send("name is required");
    }
    try {
        const group = await createGroup(
            String(name).trim(),
            roomId ?? null,
            controllerDeviceId ?? null,
            tieBreak === "off" ? "off" : "on",
            Array.isArray(memberDeviceIds) ? memberDeviceIds : []
        );
        res.status(201).json(group);
    } catch (error) {
        res.status(500).send(String(error));
    }
});

groupRouter.put("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    const { name, roomId, controllerDeviceId, tieBreak, memberDeviceIds } = req.body ?? {};
    try {
        const existing = await getGroup(id);
        if (!existing) {
            return res.status(404).send("Group not found");
        }
        await updateGroup(id, {
            ...(name !== undefined ? { name: String(name).trim() } : {}),
            ...(roomId !== undefined ? { roomId } : {}),
            ...(controllerDeviceId !== undefined ? { controllerDeviceId } : {}),
            ...(tieBreak !== undefined ? { tieBreak: tieBreak === "off" ? "off" : "on" } : {}),
        });
        if (Array.isArray(memberDeviceIds)) {
            await setMembers(id, memberDeviceIds);
        }
        res.json(await getGroup(id));
    } catch (error) {
        res.status(500).send(String(error));
    }
});

groupRouter.delete("/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    await deleteGroup(id);
    res.sendStatus(204);
});

// UI trigger.
groupRouter.post("/:id/trigger", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    const result = await triggerGroup(id);
    if (!result) {
        return res.status(404).send("Group not found");
    }
    res.json(result);
});

// Physical device webhook target (Shelly webhooks issue GET requests).
groupRouter.get("/:id/trigger", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    const result = await triggerGroup(id);
    if (!result) {
        return res.status(404).send("Group not found");
    }
    res.json(result);
});

// Assign a physical controller device and install trigger webhooks on it.
groupRouter.post("/:id/controller", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
        return res.status(400).send("Invalid group id");
    }
    const { deviceId } = req.body ?? {};
    if (!deviceId) {
        return res.status(400).send("deviceId is required");
    }
    const inputId = Number(req.body?.inputId ?? 0);
    if (!Number.isInteger(inputId) || inputId < 0) {
        return res.status(400).send("inputId must be a non-negative integer");
    }
    const group = await getGroup(id);
    if (!group) {
        return res.status(404).send("Group not found");
    }
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, String(deviceId)));
    if (!device || !device.ip) {
        return res.status(404).send("Controller device not found or has no IP");
    }
    // If a different device previously controlled this group, remove its stale hooks.
    if (group.controllerDeviceId && group.controllerDeviceId !== String(deviceId)) {
        const [previous] = await db
            .select()
            .from(devicesTable)
            .where(eq(devicesTable.id, String(group.controllerDeviceId)));
        if (previous?.ip) {
            await shellyDeleteGroupWebhooks(previous.ip, id);
        }
    }
    // Clear any existing hooks for this group on the target device to stay idempotent.
    await shellyDeleteGroupWebhooks(device.ip, id);
    const on = await shellyActivateGroupWebhook(device.ip, id, "on", inputId);
    const off = await shellyActivateGroupWebhook(device.ip, id, "off", inputId);
    if (!on || !off) {
        return res.status(502).send("Failed to install webhook on controller device");
    }
    await updateGroup(id, { controllerDeviceId: String(deviceId) });
    res.json(await getGroup(id));
});
