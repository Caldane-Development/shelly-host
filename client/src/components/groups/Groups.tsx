import { useCallback, useEffect, useState } from "react";
import style from "./groups.module.css";
import { BACKEND_URL } from "../../constants/env";

interface Room {
    id: number;
    name: string;
}

interface DeviceRow {
    id: string;
    name: string;
    roomId: number | null;
    ip: string;
}

interface GroupMember {
    deviceId: string;
    channel: number;
    name: string;
    ip: string;
    roomId: number | null;
}

interface SwitchGroup {
    id: number;
    name: string;
    roomId: number | null;
    controllerDeviceId: string | null;
    tieBreak: string;
    members: GroupMember[];
}

const emptyDraft = () => ({
    name: "",
    roomId: "" as number | "",
    tieBreak: "on",
    memberIds: [] as string[],
    controllerId: "" as string,
});

const Groups = () => {
    const [groups, setGroups] = useState<SwitchGroup[]>([]);
    const [rooms, setRooms] = useState<Room[]>([]);
    const [devices, setDevices] = useState<DeviceRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const [editingId, setEditingId] = useState<number | "new" | null>(null);
    const [draft, setDraft] = useState(emptyDraft());
    const [saving, setSaving] = useState(false);
    const [triggerInfo, setTriggerInfo] = useState<Record<number, string>>({});

    const loadAll = useCallback(async () => {
        try {
            const [groupsRes, roomsRes, devicesRes] = await Promise.all([
                fetch(`${BACKEND_URL}/group`),
                fetch(`${BACKEND_URL}/shelly/rooms`),
                fetch(`${BACKEND_URL}/shelly/devices`),
            ]);
            setGroups(groupsRes.ok ? await groupsRes.json() : []);
            setRooms(roomsRes.ok ? await roomsRes.json() : []);
            setDevices(devicesRes.ok ? await devicesRes.json() : []);
        } catch (err) {
            console.error("Failed to load groups", err);
            setError("Could not load groups from the server.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadAll();
    }, [loadAll]);

    const startCreate = () => {
        setDraft(emptyDraft());
        setEditingId("new");
    };

    const startEdit = (group: SwitchGroup) => {
        setDraft({
            name: group.name,
            roomId: group.roomId ?? "",
            tieBreak: group.tieBreak,
            memberIds: group.members.map((m) => m.deviceId),
            controllerId: group.controllerDeviceId ?? "",
        });
        setEditingId(group.id);
    };

    const cancelEdit = () => {
        setEditingId(null);
        setDraft(emptyDraft());
    };

    // Seed member selection with every device assigned to the chosen room.
    const seedFromRoom = (roomId: number | "") => {
        if (roomId === "") {
            return;
        }
        const roomDeviceIds = devices.filter((d) => d.roomId === roomId).map((d) => d.id);
        setDraft((prev) => ({
            ...prev,
            memberIds: [...new Set([...prev.memberIds, ...roomDeviceIds])],
        }));
    };

    const toggleMember = (deviceId: string) => {
        setDraft((prev) => ({
            ...prev,
            memberIds: prev.memberIds.includes(deviceId)
                ? prev.memberIds.filter((id) => id !== deviceId)
                : [...prev.memberIds, deviceId],
        }));
    };

    const saveDraft = async () => {
        if (draft.name.trim() === "") {
            setError("Group name is required.");
            return;
        }
        setSaving(true);
        setError("");
        const body = {
            name: draft.name.trim(),
            roomId: draft.roomId === "" ? null : draft.roomId,
            tieBreak: draft.tieBreak,
            memberDeviceIds: draft.memberIds,
        };
        try {
            const url = editingId === "new" ? `${BACKEND_URL}/group` : `${BACKEND_URL}/group/${editingId}`;
            const method = editingId === "new" ? "POST" : "PUT";
            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const saved: SwitchGroup = await response.json();

            // If a controller device was chosen (and it changed), install the
            // trigger webhooks on it via the dedicated endpoint. A device event
            // then toggles the whole group.
            const originalController =
                editingId === "new"
                    ? null
                    : groups.find((g) => g.id === editingId)?.controllerDeviceId ?? null;
            if (draft.controllerId !== "" && draft.controllerId !== originalController) {
                const ctrlRes = await fetch(`${BACKEND_URL}/group/${saved.id}/controller`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ deviceId: draft.controllerId }),
                });
                if (!ctrlRes.ok) {
                    throw new Error(`Failed to assign controller device: ${ctrlRes.status}`);
                }
            }

            await loadAll();
            cancelEdit();
        } catch (err) {
            console.error("Failed to save group", err);
            setError("Could not save the group.");
        } finally {
            setSaving(false);
        }
    };

    const deleteGroup = async (id: number) => {
        if (!confirm("Delete this group?")) {
            return;
        }
        try {
            await fetch(`${BACKEND_URL}/group/${id}`, { method: "DELETE" });
            await loadAll();
        } catch (err) {
            console.error("Failed to delete group", err);
            setError("Could not delete the group.");
        }
    };

    const triggerGroup = async (id: number) => {
        setTriggerInfo((prev) => ({ ...prev, [id]: "Triggering…" }));
        try {
            const response = await fetch(`${BACKEND_URL}/group/${id}/trigger`, { method: "POST" });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const result = await response.json();
            const summary =
                `Set all → ${result.target ? "ON" : "OFF"}. ` +
                `changed: ${result.changed.length}, skipped: ${result.skipped.length}` +
                (result.unreachable.length ? `, unreachable: ${result.unreachable.length}` : "");
            setTriggerInfo((prev) => ({ ...prev, [id]: summary }));
        } catch (err) {
            console.error("Failed to trigger group", err);
            setTriggerInfo((prev) => ({ ...prev, [id]: "Trigger failed." }));
        }
    };

    const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
    const roomName = (id: number | null) => (id == null ? "—" : rooms.find((r) => r.id === id)?.name ?? "—");

    return (
        <section className={style.groups}>
            <div className={style.header}>
                <h2>Switch Groups</h2>
                <button className={style.primary} onClick={startCreate}>
                    New Group
                </button>
            </div>

            {error && <p className={style.error}>{error}</p>}

            {editingId !== null && (
                <div className={style.editor}>
                    <h3>{editingId === "new" ? "New Group" : "Edit Group"}</h3>
                    <label className={style.field}>
                        <span>Name</span>
                        <input
                            value={draft.name}
                            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                            placeholder="e.g. Kitchen Lights"
                        />
                    </label>

                    <label className={style.field}>
                        <span>Seed from room</span>
                        <select
                            value={draft.roomId}
                            onChange={(e) => {
                                const value = e.target.value === "" ? "" : Number(e.target.value);
                                setDraft((prev) => ({ ...prev, roomId: value }));
                                seedFromRoom(value);
                            }}
                        >
                            <option value="">None</option>
                            {rooms.map((room) => (
                                <option key={room.id} value={room.id}>
                                    {room.name}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className={style.field}>
                        <span>Tie-break (even split)</span>
                        <select
                            value={draft.tieBreak}
                            onChange={(e) => setDraft((prev) => ({ ...prev, tieBreak: e.target.value }))}
                        >
                            <option value="on">Turn all ON</option>
                            <option value="off">Turn all OFF</option>
                        </select>
                    </label>

                    <label className={style.field}>
                        <span>Controller device (its button event toggles this group)</span>
                        <select
                            value={draft.controllerId}
                            onChange={(e) =>
                                setDraft((prev) => ({ ...prev, controllerId: e.target.value }))
                            }
                        >
                            <option value="">None</option>
                            {devices.map((device) => (
                                <option key={device.id} value={device.id}>
                                    {device.name} ({roomName(device.roomId)})
                                </option>
                            ))}
                        </select>
                    </label>

                    <div className={style.members}>
                        <span className={style["members-title"]}>Members</span>
                        <div className={style["members-list"]}>
                            {devices.map((device) => (
                                <label key={device.id} className={style.member}>
                                    <input
                                        type="checkbox"
                                        checked={draft.memberIds.includes(device.id)}
                                        onChange={() => toggleMember(device.id)}
                                    />
                                    <span>{device.name}</span>
                                    <span className={style.meta}>{roomName(device.roomId)}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={style.actions}>
                        <button className={style.secondary} onClick={cancelEdit} disabled={saving}>
                            Cancel
                        </button>
                        <button className={style.primary} onClick={saveDraft} disabled={saving}>
                            {saving ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>
            )}

            {loading ? (
                <p className={style.loading}>Loading groups…</p>
            ) : groups.length === 0 ? (
                <p className={style.loading}>No groups yet. Create one to control multiple devices at once.</p>
            ) : (
                <div className={style.grid}>
                    {groups.map((group) => (
                        <article key={group.id} className={style.card}>
                            <span className={style.name}>{group.name}</span>
                            <span className={style.meta}>Room: {roomName(group.roomId)}</span>
                            <span className={style.meta}>
                                Tie-break: all {group.tieBreak === "off" ? "OFF" : "ON"}
                            </span>
                            <span className={style.meta}>
                                Controller: {group.controllerDeviceId ? deviceName(group.controllerDeviceId) : "—"}
                            </span>
                            <ul className={style["member-tags"]}>
                                {group.members.map((member) => (
                                    <li key={member.deviceId}>{member.name || deviceName(member.deviceId)}</li>
                                ))}
                            </ul>
                            {triggerInfo[group.id] && (
                                <span className={style.trigger}>{triggerInfo[group.id]}</span>
                            )}
                            <div className={style.actions}>
                                <button className={style.primary} onClick={() => triggerGroup(group.id)}>
                                    Trigger
                                </button>
                                <button className={style.secondary} onClick={() => startEdit(group)}>
                                    Edit
                                </button>
                                <button className={style.danger} onClick={() => deleteGroup(group.id)}>
                                    Delete
                                </button>
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
};

export default Groups;
