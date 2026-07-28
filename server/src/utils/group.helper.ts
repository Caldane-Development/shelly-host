import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { switchGroups, switchGroupMembers, devices as devicesTable } from "../db/schema";
import { logger } from "../logger";
import { discoverShelly, shellySetSwitch } from "./discovery.helper";

export interface GroupMember {
    deviceId: string;
    channel: number;
    name: string;
    ip: string;
    roomId: number | null;
}

export interface SwitchGroup {
    id: number;
    name: string;
    roomId: number | null;
    tieBreak: string;
    members: GroupMember[];
}

const loadMembers = async (groupId: number): Promise<GroupMember[]> => {
    const memberRows = await db
        .select()
        .from(switchGroupMembers)
        .where(eq(switchGroupMembers.groupId, groupId));

    if (memberRows.length === 0) {
        return [];
    }

    const ids = memberRows.map((row) => row.deviceId);
    const deviceRows = await db.select().from(devicesTable).where(inArray(devicesTable.id, ids));
    const byId = new Map(deviceRows.map((row) => [row.id, row]));

    return memberRows.map((row) => {
        const device = byId.get(row.deviceId);
        return {
            deviceId: row.deviceId,
            channel: row.channel,
            name: device?.name ?? row.deviceId,
            ip: device?.ip ?? "",
            roomId: device?.roomId ?? null,
        };
    });
};

export const getGroups = async (): Promise<SwitchGroup[]> => {
    const groups = await db.select().from(switchGroups).orderBy(switchGroups.name);
    return Promise.all(
        groups.map(async (group) => ({
            id: group.id,
            name: group.name,
            roomId: group.roomId,
            tieBreak: group.tieBreak,
            members: await loadMembers(group.id),
        }))
    );
};

export const getGroup = async (id: number): Promise<SwitchGroup | null> => {
    const [group] = await db.select().from(switchGroups).where(eq(switchGroups.id, id));
    if (!group) {
        return null;
    }
    return {
        id: group.id,
        name: group.name,
        roomId: group.roomId,
        tieBreak: group.tieBreak,
        members: await loadMembers(group.id),
    };
};

export const createGroup = async (
    name: string,
    roomId: number | null,
    tieBreak: string,
    memberDeviceIds: string[]
): Promise<SwitchGroup> => {
    const [group] = await db
        .insert(switchGroups)
        .values({ name, roomId, tieBreak, modified: new Date() })
        .returning();

    await setMembers(group.id, memberDeviceIds);
    return (await getGroup(group.id))!;
};

export const updateGroup = async (
    id: number,
    update: { name?: string; roomId?: number | null; tieBreak?: string }
): Promise<SwitchGroup | null> => {
    await db
        .update(switchGroups)
        .set({ ...update, modified: new Date() })
        .where(eq(switchGroups.id, id));
    return getGroup(id);
};

export const deleteGroup = async (id: number): Promise<void> => {
    await db.delete(switchGroupMembers).where(eq(switchGroupMembers.groupId, id));
    await db.delete(switchGroups).where(eq(switchGroups.id, id));
};

// Replace the full member set of a group. Channel defaults to 0 per device.
export const setMembers = async (groupId: number, deviceIds: string[]): Promise<void> => {
    await db.delete(switchGroupMembers).where(eq(switchGroupMembers.groupId, groupId));
    const unique = [...new Set(deviceIds.filter((id) => id && id.trim() !== ""))];
    if (unique.length === 0) {
        return;
    }
    await db
        .insert(switchGroupMembers)
        .values(unique.map((deviceId) => ({ groupId, deviceId, channel: 0 })));
};

export interface TriggerResult {
    groupId: number;
    target: boolean;
    onCount: number;
    offCount: number;
    changed: string[];
    skipped: string[];
    unreachable: string[];
}

// Smart trigger: read every member's live state over HTTP, pick the target as
// the OPPOSITE of the majority (tie -> group's tieBreak), then set only the
// members that are not already at the target.
export const triggerGroup = async (id: number): Promise<TriggerResult | null> => {
    const group = await getGroup(id);
    if (!group) {
        return null;
    }

    const reachable: { member: GroupMember; output: boolean }[] = [];
    const unreachable: string[] = [];

    await Promise.all(
        group.members.map(async (member) => {
            if (!member.ip) {
                unreachable.push(member.name);
                return;
            }
            const status = await discoverShelly(member.ip);
            const switchKey = `switch:${member.channel}` as const;
            const output = (status as Record<string, { output?: boolean }> | null)?.[switchKey]?.output;
            if (status && output !== undefined) {
                reachable.push({ member, output: Boolean(output) });
            } else {
                unreachable.push(member.name);
            }
        })
    );

    const onCount = reachable.filter((r) => r.output).length;
    const offCount = reachable.length - onCount;

    // target = opposite of majority; a tie uses the configured tie-break.
    let target: boolean;
    if (onCount > offCount) {
        target = false;
    } else if (offCount > onCount) {
        target = true;
    } else {
        target = group.tieBreak !== "off";
    }

    const changed: string[] = [];
    const skipped: string[] = [];

    await Promise.all(
        reachable.map(async ({ member, output }) => {
            if (output === target) {
                skipped.push(member.name);
                return;
            }
            const ok = await shellySetSwitch(member.ip, target, member.channel);
            if (ok) {
                changed.push(member.name);
            } else {
                unreachable.push(member.name);
            }
        })
    );

    logger.request(
        `[server]: Triggered group ${group.name} (#${id}): target=${target ? "on" : "off"} ` +
            `changed=[${changed.join(", ")}] skipped=[${skipped.join(", ")}] unreachable=[${unreachable.join(", ")}]`
    );

    return { groupId: id, target, onCount, offCount, changed, skipped, unreachable };
};
