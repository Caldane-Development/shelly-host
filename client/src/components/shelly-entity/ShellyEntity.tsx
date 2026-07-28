import { faCloudArrowUp, faCopy, faLink, faMessage, faObjectGroup, faPen, faPowerOff, faTowerBroadcast, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useState } from "react";
import { IDevice } from "../../../../common/models/device.interface";
import { BACKEND_URL } from "../../constants/env";
import style from "./shelly-entity.module.css";

const TOGGLE_MESSAGE = { src: "buffington.action", method: "Switch.Toggle", params: { id: 0 } };

const slugify = (text: string) => text.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();
const linkMessagePattern = /\/api\/message\/srd\/[^/]+\/(\d+)\/([^/]+)\/switch\/message\/toggle\/[^/?#]+/i;
const linkGroupPattern = /\/api\/group\/\d+\/trigger/i;

const hasLinkedActions = (device: IDevice, inputId?: number): boolean => {
    const hooks = device.webhooks?.result?.hooks ?? [];
    if (!hooks.length) {
        return false;
    }

    const sourceSlug = slugify(device.name || "");

    for (const hook of hooks) {
        if (inputId !== undefined && Number(hook.cid ?? 0) !== inputId) {
            continue;
        }
        for (const url of hook.urls ?? []) {
            if (linkGroupPattern.test(url)) {
                return true;
            }
            const match = linkMessagePattern.exec(url);
            if (!match) {
                continue;
            }
            const targetSlug = slugify(match[2] || "");
            // Keep parity with server-side linked inference: webhook URLs with
            // matching target slug are treated as self-targeted even if legacy
            // room IDs in the URL are out of date.
            if (targetSlug !== sourceSlug) {
                return true;
            }
        }
    }

    return false;
};

interface DialogBroker {
    id: number;
    server: string;
}

interface DialogRoom {
    name: string;
    switches: { name: string }[];
}

interface WifiCredential {
    id: number;
    ssid: string;
    password: string;
}

interface StoredRoom {
    id: number;
    name: string;
}

const GROUPS_ROOM_VALUE = "__groups__";

export interface DeviceGroup {
    id: number;
    name: string;
    members?: { deviceId: string }[];
}

const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`**Copied to clipboard**\n${label}:\n${text}`);
};

const ShellyEntity = ({
    device,
    displayName,
    inputIndex,
    lockInputSelection,
    linkedPowerStatus,
    mode,
    groups = [],
    onGroupsChanged,
    onDeviceUpdated,
    onStatusRefresh,
}: {
    device: IDevice;
    displayName?: string;
    inputIndex?: number;
    lockInputSelection?: boolean;
    linkedPowerStatus?: boolean;
    mode: string;
    groups?: DeviceGroup[];
    onGroupsChanged?: () => void;
    onDeviceUpdated?: (device: IDevice) => void;
    onStatusRefresh?: () => void;
}) => {
    const [deviceEntity, setDeviceEntity] = useState(device);
    const [deviceName, setDeviceName] = useState(device.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());

    // Enable-MQTT dialog state
    const [showDialog, setShowDialog] = useState(false);
    const [dialogBrokers, setDialogBrokers] = useState<DialogBroker[]>([]);
    const [dialogRooms, setDialogRooms] = useState<DialogRoom[]>([]);
    const [siteName, setSiteName] = useState("");
    const [selServer, setSelServer] = useState("");
    const [topicMode, setTopicMode] = useState<"new" | "existing">("new");
    const [selRoom, setSelRoom] = useState("");
    const [selSwitch, setSelSwitch] = useState("");
    const [topicSwitch, setTopicSwitch] = useState("switch");
    const [dialogError, setDialogError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Change-WiFi dialog state
    const [wifiCredentials, setWifiCredentials] = useState<WifiCredential[]>([]);
    const [selSsid, setSelSsid] = useState("");
    const [wifiDialogError, setWifiDialogError] = useState("");
    const [wifiSubmitting, setWifiSubmitting] = useState(false);

    // Manual room edit dialog state
    const [showRoomDialog, setShowRoomDialog] = useState(false);
    const [roomOptions, setRoomOptions] = useState<StoredRoom[]>([]);
    const [selRoomId, setSelRoomId] = useState<string>("");
    const [roomDialogError, setRoomDialogError] = useState("");
    const [roomSubmitting, setRoomSubmitting] = useState(false);

    // Link Device dialog state
    const [showCompanionDialog, setShowCompanionDialog] = useState(false);
    const [companionDevices, setCompanionDevices] = useState<IDevice[]>([]);
    const [companionRooms, setCompanionRooms] = useState<StoredRoom[]>([]);
    const [selCompRoom, setSelCompRoom] = useState<string>("");
    const [selCompTarget, setSelCompTarget] = useState<string>("");
    const [selCompGroup, setSelCompGroup] = useState<string>("");
    const [selCompInput, setSelCompInput] = useState<string>("0");
    const [detachLocal, setDetachLocal] = useState(true);
    const [companionError, setCompanionError] = useState("");
    const [companionSubmitting, setCompanionSubmitting] = useState(false);

    // Number of physical inputs on this device: input-only devices (i4) expose
    // channels_count inputs; relay devices are treated as a single input.
    const inputCount =
        deviceEntity.device?.category === "inputs_reader"
            ? Math.max(1, Number(deviceEntity.device?.channels_count) || 1)
            : 1;
    const resolvedInputIndex = Number.isInteger(inputIndex) && (inputIndex ?? -1) >= 0 ? Number(inputIndex) : 0;
    const isInputTile = deviceEntity.device?.category === "inputs_reader";
    // Only relay devices have a local relay worth detaching.
    const hasLocalRelay = deviceEntity.device?.category !== "inputs_reader";

    useEffect(() => {
        setDeviceEntity(device);
        setDeviceName(device.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
    }, [device]);

    const applyDeviceUpdate = (updated: IDevice) => {
        const next: IDevice = {
            ...deviceEntity,
            ...updated,
            linked: updated.linked ?? deviceEntity.linked,
        };
        setDeviceEntity(next);
        setDeviceName(next.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
        onDeviceUpdated?.(next);
    };


    const activateMqtt = async (device: IDevice) => {
        const response = await fetch(`${BACKEND_URL}/shelly/${device.ip}/mqtt`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ device }),
        });
        if (response.ok) {
            const data = await response.json();
            applyDeviceUpdate(data);
            console.log("MQTT activated successfully");
        } else {
            console.error("Failed to activate MQTT");
        }
    };

    const activateWebhook = async (device: IDevice) => {
        const response = await fetch(`${BACKEND_URL}/shelly/${device.ip}/webhook`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ device }),
        });
        if (response.ok) {
            const data = await response.json();
            applyDeviceUpdate(data);
            console.log("Webhook activated successfully");
        } else {
            console.error("Failed to activate Webhook");
        }
    };

    const handleMqtt = async (device: IDevice) => {
        await activateMqtt(device);
        setDeviceEntity((prev) => ({ ...prev, mqtt: { ...prev.mqtt, enable: true } }));
    };

    const currentRoomSlug = slugify(deviceEntity.room?.name || "default");

    const buildTopicPrefix = () => {
        if (topicMode === "existing") {
            return `${siteName}/${selRoom}/${selSwitch}/switch`;
        }
        return `${siteName}/${currentRoomSlug}/${deviceName}/${slugify(topicSwitch) || "switch"}`;
    };

    const openDialog = async () => {
        setDialogError("");
        setTopicMode("new");
        setTopicSwitch("switch");
        setShowDialog(true);

        try {
            const [brokersRes, roomsRes, devicesRes, siteRes] = await Promise.all([
                fetch(`${BACKEND_URL}/mqtt-broker`),
                fetch(`${BACKEND_URL}/shelly/rooms`),
                fetch(`${BACKEND_URL}/shelly/devices`),
                fetch(`${BACKEND_URL}/site-config`),
            ]);

            const brokers: DialogBroker[] = brokersRes.ok ? await brokersRes.json() : [];
            const roomRows: { id: number; name: string }[] = roomsRes.ok ? await roomsRes.json() : [];
            const deviceRows: { id: string; name: string; roomId: number | null }[] = devicesRes.ok
                ? await devicesRes.json()
                : [];
            const site: { name: string } = siteRes.ok ? await siteRes.json() : { name: "" };

            // Build the room -> switch cascade from the DB so every real room
            // (not just the site.json catalog) is available for mirroring.
            const rooms: DialogRoom[] = roomRows.map((room) => ({
                name: room.name,
                switches: deviceRows
                    .filter((d) => d.roomId === room.id)
                    .map((d) => ({ name: d.name })),
            }));

            setDialogBrokers(brokers);
            setDialogRooms(rooms);
            setSiteName(site.name || "");
            setSelServer(deviceEntity.mqtt?.server || brokers[0]?.server || "");

            // Preselect the device's current room if it exists in the list.
            const matchedRoom = rooms.find((room) => slugify(room.name) === currentRoomSlug);
            const defaultRoom = matchedRoom ?? rooms[0];
            setSelRoom(defaultRoom ? slugify(defaultRoom.name) : "");
            setSelSwitch(defaultRoom?.switches[0] ? slugify(defaultRoom.switches[0].name) : "");
        } catch (err) {
            console.error("Failed to load enable-MQTT options", err);
            setDialogError("Could not load MQTT options from the server.");
        }
    };

    const closeDialog = () => {
        setShowDialog(false);
        setDialogError("");
    };

    const selectedRoomSwitches = dialogRooms.find((room) => slugify(room.name) === selRoom)?.switches ?? [];

    const submitEnableMqtt = async () => {
        if (selServer.trim() === "") {
            setDialogError("Choose an MQTT broker.");
            return;
        }
        if (topicMode === "existing" && (selRoom === "" || selSwitch === "")) {
            setDialogError("Choose a room and a switch to mirror.");
            return;
        }

        const topicPrefix = buildTopicPrefix();
        setSubmitting(true);
        setDialogError("");

        try {
            const response = await fetch(`${BACKEND_URL}/shelly/${deviceEntity.ip}/mqtt`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ device: deviceEntity, server: selServer, topicPrefix }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data = await response.json();
            applyDeviceUpdate(data);
            closeDialog();
        } catch (err) {
            console.error("Failed to enable MQTT", err);
            setDialogError("Could not enable MQTT on the device.");
        } finally {
            setSubmitting(false);
        }
    };

    const openRoomDialog = async () => {
        setRoomDialogError("");
        setWifiDialogError("");
        setShowRoomDialog(true);
        try {
            const [roomsResponse, wifiResponse] = await Promise.all([
                fetch(`${BACKEND_URL}/shelly/rooms`),
                fetch(`${BACKEND_URL}/wifi`),
            ]);
            const rooms: StoredRoom[] = roomsResponse.ok ? await roomsResponse.json() : [];
            const creds: WifiCredential[] = wifiResponse.ok ? await wifiResponse.json() : [];
            const sorted = [...rooms].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            setRoomOptions(sorted);
            setWifiCredentials(creds);
            setSelSsid(creds[0]?.ssid || "");

            const currentRoomId = Number(deviceEntity.room?.id);
            const defaultRoomId = Number.isInteger(currentRoomId) && currentRoomId > 0
                ? currentRoomId
                : (sorted[0]?.id ?? 0);
            setSelRoomId(defaultRoomId > 0 ? String(defaultRoomId) : "");
        } catch (err) {
            console.error("Failed to load edit options", err);
            setRoomDialogError("Could not load edit options from the server.");
        }
    };

    const closeRoomDialog = () => {
        setShowRoomDialog(false);
        setRoomDialogError("");
        setWifiDialogError("");
    };

    const submitRoomChange = async () => {
        const roomId = Number(selRoomId);
        const deviceId = String(deviceEntity.device?.id ?? "").trim();

        if (!deviceId) {
            setRoomDialogError("This device is missing an id.");
            return;
        }
        if (!Number.isInteger(roomId) || roomId <= 0) {
            setRoomDialogError("Choose a room.");
            return;
        }

        setRoomSubmitting(true);
        setRoomDialogError("");

        try {
            const response = await fetch(`${BACKEND_URL}/shelly/devices/${deviceId}/room`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roomId }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(payload?.error || `Request failed: ${response.status}`);
            }

            if (payload?.device) {
                applyDeviceUpdate(payload.device as IDevice);
            }
            closeRoomDialog();
        } catch (err) {
            console.error("Failed to update room", err);
            setRoomDialogError(err instanceof Error ? err.message : "Could not update room.");
        } finally {
            setRoomSubmitting(false);
        }
    };

    const submitChangeWifi = async () => {
        if (selSsid.trim() === "") {
            setWifiDialogError("Choose a WiFi network.");
            return;
        }

        setWifiSubmitting(true);
        setWifiDialogError("");

        try {
            const response = await fetch(`${BACKEND_URL}/shelly/${deviceEntity.ip}/wifi`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ssid: selSsid }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            closeRoomDialog();
            alert(
                `WiFi change sent to ${deviceEntity.name}.\n\nThe device will reboot and reconnect to "${selSsid}". ` +
                    `It will get a new IP on that network, so re-run the scanner to find it again.`
            );
        } catch (err) {
            console.error("Failed to change WiFi", err);
            setWifiDialogError("Could not change the WiFi on the device.");
        } finally {
            setWifiSubmitting(false);
        }
    };

    const openCompanionDialog = async () => {
        setCompanionError("");
        setDetachLocal(hasLocalRelay);
        setSelCompInput(String(resolvedInputIndex));
        setShowCompanionDialog(true);
        try {
            const [roomsResponse, devicesResponse] = await Promise.all([
                fetch(`${BACKEND_URL}/shelly/rooms`),
                fetch(`${BACKEND_URL}/shelly/devices/detailed`),
            ]);
            const rooms: StoredRoom[] = roomsResponse.ok ? await roomsResponse.json() : [];
            const devices: IDevice[] = devicesResponse.ok ? await devicesResponse.json() : [];

            // Exclude this device from the target list and only allow linking to
            // MQTT-enabled targets so we never need an RPC fallback path.
            const targets = devices.filter((d) => d.ip && d.ip !== deviceEntity.ip && Boolean(d.mqtt?.enable));
            setCompanionDevices(targets);
            const sortedRooms = [...rooms].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            setCompanionRooms(sortedRooms);

            const preferredRoom = deviceEntity.room?.name ?? "";
            const firstRoom = sortedRooms.find((room) => room.name === preferredRoom)?.name || sortedRooms[0]?.name || "";
            setSelCompRoom(firstRoom);
            const firstTarget = targets.find((d) => (d.room?.name ?? "") === firstRoom);
            setSelCompTarget(firstTarget?.ip ?? "");
            const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            setSelCompGroup(sortedGroups[0] ? String(sortedGroups[0].id) : "");
        } catch (err) {
            console.error("Failed to load devices", err);
            setCompanionError("Could not load devices from the server.");
        }
    };

    const closeCompanionDialog = () => {
        setShowCompanionDialog(false);
        setCompanionError("");
    };

    const submitCompanion = async () => {
        const linkingToGroup = selCompRoom === GROUPS_ROOM_VALUE;
        if (linkingToGroup) {
            if (selCompGroup === "") {
                setCompanionError("Choose a switch group.");
                return;
            }
        } else if (selCompTarget === "") {
            setCompanionError("Choose a target device.");
            return;
        }
        setCompanionSubmitting(true);
        setCompanionError("");
        try {
            if (linkingToGroup) {
                const deviceId = deviceEntity.device?.id?.toString();
                if (!deviceId) {
                    setCompanionError("This device has no id; re-run the scanner first.");
                    return;
                }
                const response = await fetch(`${BACKEND_URL}/group/${selCompGroup}/controller`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ deviceId, inputId: Number(selCompInput) }),
                });
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }

                const groupName = groups.find((g) => String(g.id) === selCompGroup)?.name ?? selCompGroup;
                closeCompanionDialog();
                onGroupsChanged?.();
                setDeviceEntity((prev) => ({ ...prev, linked: true }));
                alert(`${deviceEntity.name} now links to switch group "${groupName}".`);
            } else {
                const response = await fetch(`${BACKEND_URL}/shelly/${deviceEntity.ip}/companion`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        targetIp: selCompTarget,
                        inputId: Number(selCompInput),
                        detach: detachLocal,
                    }),
                });
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }

                const targetName =
                    companionDevices.find((d) => d.ip === selCompTarget)?.name ?? selCompTarget;
                closeCompanionDialog();
                setDeviceEntity((prev) => ({ ...prev, linked: true }));
                alert(`${deviceEntity.name} (input ${selCompInput}) now links to "${targetName}".`);
            }
        } catch (err) {
            console.error("Failed to link companion switch", err);
            setCompanionError(
                "Could not link the device. Make sure both devices are online, reachable, and MQTT-enabled."
            );
        } finally {
            setCompanionSubmitting(false);
        }
    };

    const companionTargets = companionDevices.filter((d) => (d.room?.name ?? "") === selCompRoom);
    const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const roomChoices = [
        ...companionRooms.map((room) => ({ value: room.name, label: room.name })),
        { value: GROUPS_ROOM_VALUE, label: "Groups" },
    ].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    // Devices that share a topic (e.g. a 3-way pairing) all react to the same
    // message, so this drives the whole logical switch rather than one relay.
    const togglePower = async (device: IDevice) => {
        const name = device.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();
        try {
            const response = await fetch(`${BACKEND_URL}/message/client/${name}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: { id: device.ip, ...TOGGLE_MESSAGE },
                    channel: device.mqtt.topic_prefix,
                }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
        } catch (err) {
            console.error("Failed to toggle device over MQTT", err);
        }
    };

    const persistedInputTargets = deviceEntity.linkedInputTargets?.[String(resolvedInputIndex)] ?? [];
    const linkedByHooks = hasLinkedActions(deviceEntity, isInputTile ? resolvedInputIndex : undefined);
    const linked = isInputTile
        ? persistedInputTargets.length > 0 || linkedByHooks
        : hasLinkedActions(deviceEntity) || Boolean(deviceEntity.linked);
    const switchState = isInputTile
        ? Boolean(deviceEntity.inputStates?.[resolvedInputIndex])
        : Boolean(deviceEntity?.switchStatus?.output);
    const linkedTargets = (() => {
        const details = new Set<string>();

        const persistedTargets = isInputTile ? persistedInputTargets : (deviceEntity.linkedTargets ?? []);
        persistedTargets.forEach((target) => {
            if (target.trim() !== "") {
                details.add(target.trim());
            }
        });

        const sourceSlug = slugify(deviceEntity.name || "");

        const hooks = deviceEntity.webhooks?.result?.hooks ?? [];
        for (const hook of hooks) {
            if (isInputTile && Number(hook.cid ?? 0) !== resolvedInputIndex) {
                continue;
            }
            for (const url of hook.urls ?? []) {
                const groupMatch = url.match(/\/api\/group\/(\d+)\/trigger/i);
                if (groupMatch) {
                    const id = Number(groupMatch[1]);
                    const groupName = groups.find((g) => g.id === id)?.name;
                    details.add(groupName ? `Group: ${groupName}` : `Group ID: ${id}`);
                    continue;
                }

                const messageMatch = linkMessagePattern.exec(url);
                if (!messageMatch) {
                    continue;
                }

                const targetSlug = slugify(messageMatch[2] || "");
                if (targetSlug && targetSlug !== sourceSlug) {
                    details.add(`Device: ${targetSlug}`);
                }
            }
        }

        return [...details].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    })();
    const linkedTitle = linkedTargets.length > 0
        ? linkedTargets.join("; ")
        : linked
            ? "Linked target details not loaded in this view"
            : "Not linked";
    const powerStatus = linked ? Boolean(linkedPowerStatus) : switchState;

    const triggerLinked = async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/shelly/${deviceEntity.ip}/linked-trigger`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ inputId: resolvedInputIndex }),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.error || `Request failed: ${response.status}`);
            }
            onStatusRefresh?.();
        } catch (err) {
            console.error("Failed to trigger linked action", err);
            alert(err instanceof Error ? err.message : "Could not trigger linked action.");
        }
    };

    return (
        <section
            className={style["shelly-entity"]}
            data-mqtt={deviceEntity.mqtt?.enable ? "" : undefined}
            data-linked={linked ? "" : undefined}
            data-verify-warning={deviceEntity.verificationWarning ? "" : undefined}
            data-ip={deviceEntity.ip}
        >
            <h3 onClick={() => window.open(`http://${deviceEntity.ip}`, "_blank")}>{displayName ?? deviceEntity.name}</h3>
            <p>
                <b>IP Address:</b> {deviceEntity.ip}
            </p>
            <p>
                <b>Type:</b> {deviceEntity.type}
            </p>
            <p>
                <b>Room:</b> {deviceEntity.room?.name || "No room assigned"}
            </p>
            <p>
                <b>State:</b> {switchState ? "On" : "Off"}
            </p>
            <p>
                <b>WiFi:</b> {deviceEntity.device?.ssid || "N/A"}
            </p>
            <p>
                <b>MQTT Server:</b> {deviceEntity.mqtt?.server || "N/A"}
            </p>
            {deviceEntity.verificationWarning && (
                <p className={style.warning} title={deviceEntity.verificationWarning}>
                    <b>MQTT Verify:</b> Pending device recheck
                </p>
            )}
            <p className={style.topic}>
                <b>MQTT Topic:</b>{" "}
                {deviceEntity.mqtt?.topic_prefix ? (
                    <span
                        className={style["topic-value"]}
                        title={`${deviceEntity.mqtt.topic_prefix} (click to copy)`}
                        onClick={() => copy(deviceEntity.mqtt.topic_prefix, "MQTT Topic")}
                    >
                        {deviceEntity.mqtt.topic_prefix}
                    </span>
                ) : (
                    "N/A"
                )}
            </p>
            <p>
                <b title={linkedTitle}>Linked:</b> <span title={linkedTitle}>{linked ? "Yes" : "No"}</span>
            </p>
            <p>
                {(mode == "debug" || mode == "dev") && (
                    <button onClick={() => handleMqtt(deviceEntity)}>
                        <b>MQTT:</b> {deviceEntity.mqtt?.enable.toString()}
                    </button>
                )}
                {(deviceEntity.mqtt?.enable || linked) && (
                    <button className={style["power-button"]} onClick={() => (linked ? triggerLinked() : togglePower(deviceEntity))}>
                        <FontAwesomeIcon icon={faPowerOff} data-status={powerStatus} />
                    </button>
                )}
                {mode === "normal" && !deviceEntity.mqtt?.enable && (
                    <button className={style["enable-mqtt"]} onClick={openDialog} title="Enable MQTT">
                        <FontAwesomeIcon icon={faTowerBroadcast} />
                    </button>
                )}
                {mode === "normal" && (
                    <button
                        className={style["change-wifi"]}
                        onClick={openCompanionDialog}
                        title="Link Device"
                    >
                        <FontAwesomeIcon icon={faLink} />
                    </button>
                )}
                {mode === "normal" && (
                    <button
                        className={style["change-wifi"]}
                        onClick={openRoomDialog}
                        title="Edit Room"
                    >
                        <FontAwesomeIcon icon={faPen} />
                    </button>
                )}
            </p>
            {mode == "debug" && (
                <p className={style.tools}>
                    {deviceEntity.mqtt?.enable && (
                        <button onClick={() => copy(`${deviceEntity.mqtt?.topic_prefix}/rpc`, "MQTT Topic")} title="Copy MQTT Topic Prefix">
                            <FontAwesomeIcon icon={faMessage} />
                        </button>
                    )}
                    {deviceEntity.room !== undefined && deviceEntity.room.id && (
                        <button
                            title="Copy Webhook Url"
                            onClick={() =>
                                copy(
                                    `${BACKEND_URL}/api/message/srd/buffington/${deviceEntity?.room?.id}/${deviceName}/switch/message/toggle/shelly`,
                                    "Webhook Url"
                                )
                            }
                        >
                            <FontAwesomeIcon icon={faCopy} />
                        </button>
                    )}
                    {deviceEntity.webhooks && deviceEntity.webhooks.result.hooks.length > 0 && (
                        <button
                            onClick={() =>
                                copy(deviceEntity?.webhooks?.result.hooks.map((hook) => `${hook.name}:\n${hook.urls}`).join("\n\n") || "", "Active Webhooks:")
                            }
                            title="Webhook URLs"
                        >
                            <FontAwesomeIcon icon={faObjectGroup} />
                        </button>
                    )}
                    <button onClick={() => activateWebhook(deviceEntity)} title="Activate Webhook">
                        <FontAwesomeIcon icon={faCloudArrowUp} />
                    </button>
                </p>
            )}
            {showDialog && (
                <div className={style["dialog-overlay"]} onClick={closeDialog}>
                    <div className={style.dialog} onClick={(e) => e.stopPropagation()}>
                        <div className={style["dialog-header"]}>
                            <h4>Enable MQTT — {deviceEntity.name}</h4>
                            <button className={style["dialog-close"]} onClick={closeDialog} aria-label="Close">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>

                        <label className={style["dialog-field"]}>
                            <span>MQTT Broker</span>
                            <select
                                value={selServer}
                                onChange={(e) => {
                                    setSelServer(e.target.value);
                                    if (dialogError) setDialogError("");
                                }}
                            >
                                <option value="">Select a broker…</option>
                                {dialogBrokers.map((broker) => (
                                    <option key={broker.id} value={broker.server}>
                                        {broker.server}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <div className={style["dialog-toggle"]}>
                            <button
                                type="button"
                                className={topicMode === "new" ? style["toggle-active"] : undefined}
                                onClick={() => setTopicMode("new")}
                            >
                                New Topic
                            </button>
                            <button
                                type="button"
                                className={topicMode === "existing" ? style["toggle-active"] : undefined}
                                onClick={() => setTopicMode("existing")}
                            >
                                Existing Topic
                            </button>
                        </div>

                        {topicMode === "existing" ? (
                            <>
                                <label className={style["dialog-field"]}>
                                    <span>Room</span>
                                    <select
                                        value={selRoom}
                                        onChange={(e) => {
                                            const roomSlug = e.target.value;
                                            setSelRoom(roomSlug);
                                            const room = dialogRooms.find((r) => slugify(r.name) === roomSlug);
                                            setSelSwitch(room?.switches[0] ? slugify(room.switches[0].name) : "");
                                            if (dialogError) setDialogError("");
                                        }}
                                    >
                                        {dialogRooms.map((room) => (
                                            <option key={room.name} value={slugify(room.name)}>
                                                {room.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className={style["dialog-field"]}>
                                    <span>Switch</span>
                                    <select
                                        value={selSwitch}
                                        onChange={(e) => {
                                            setSelSwitch(e.target.value);
                                            if (dialogError) setDialogError("");
                                        }}
                                    >
                                        {selectedRoomSwitches.length === 0 ? (
                                            <option value="">No switches in this room</option>
                                        ) : (
                                            selectedRoomSwitches.map((sw) => (
                                                <option key={sw.name} value={slugify(sw.name)}>
                                                    {sw.name}
                                                </option>
                                            ))
                                        )}
                                    </select>
                                </label>
                            </>
                        ) : (
                            <>
                                <label className={style["dialog-field"]}>
                                    <span>Room</span>
                                    <input type="text" value={deviceEntity.room?.name || "No room assigned"} disabled />
                                </label>
                                <label className={style["dialog-field"]}>
                                    <span>Topic Switch</span>
                                    <input
                                        type="text"
                                        value={topicSwitch}
                                        onChange={(e) => {
                                            setTopicSwitch(e.target.value);
                                            if (dialogError) setDialogError("");
                                        }}
                                        placeholder="switch"
                                    />
                                </label>
                            </>
                        )}

                        <div className={style["dialog-preview"]}>
                            <span>Topic</span>
                            <code>{buildTopicPrefix()}</code>
                        </div>

                        {dialogError && <p className={style.error}>{dialogError}</p>}

                        <div className={style["dialog-actions"]}>
                            <button type="button" className={style["dialog-cancel"]} onClick={closeDialog} disabled={submitting}>
                                Cancel
                            </button>
                            <button type="button" className={style["dialog-submit"]} onClick={submitEnableMqtt} disabled={submitting}>
                                {submitting ? "Enabling…" : "Enable MQTT"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {showCompanionDialog && (
                <div className={style["dialog-overlay"]} onClick={closeCompanionDialog}>
                    <div className={style.dialog} onClick={(e) => e.stopPropagation()}>
                        <div className={style["dialog-header"]}>
                            <h4>Link Device — {deviceEntity.name}</h4>
                            <button className={style["dialog-close"]} onClick={closeCompanionDialog} aria-label="Close">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>

                        <p className={style["dialog-note"]}>
                            Flipping <b>{deviceEntity.name}</b> will toggle the linked target device.
                            Pick a room to link to an MQTT-enabled target device, or choose Groups to link this
                            input to a switch group trigger.
                        </p>

                        <label className={style["dialog-field"]}>
                            <span>Room</span>
                            <select
                                value={selCompRoom}
                                onChange={(e) => {
                                    const room = e.target.value;
                                    setSelCompRoom(room);
                                    if (room === GROUPS_ROOM_VALUE) {
                                        setSelCompTarget("");
                                        setSelCompGroup(sortedGroups[0] ? String(sortedGroups[0].id) : "");
                                    } else {
                                        const first = companionDevices.find((d) => (d.room?.name ?? "") === room);
                                        setSelCompTarget(first?.ip ?? "");
                                    }
                                    if (companionError) setCompanionError("");
                                }}
                            >
                                {roomChoices.length === 0 ? (
                                    <option value="">No devices found</option>
                                ) : (
                                    roomChoices.map((room) => (
                                        <option key={room.value} value={room.value}>
                                            {room.label}
                                        </option>
                                    ))
                                )}
                            </select>
                        </label>

                        {selCompRoom === GROUPS_ROOM_VALUE ? (
                            <label className={style["dialog-field"]}>
                                <span>Switch Group</span>
                                <select
                                    value={selCompGroup}
                                    onChange={(e) => {
                                        setSelCompGroup(e.target.value);
                                        if (companionError) setCompanionError("");
                                    }}
                                >
                                    {sortedGroups.length === 0 ? (
                                        <option value="">No switch groups</option>
                                    ) : (
                                        sortedGroups.map((group) => (
                                            <option key={group.id} value={String(group.id)}>
                                                {group.name}
                                            </option>
                                        ))
                                    )}
                                </select>
                            </label>
                        ) : (
                            <label className={style["dialog-field"]}>
                                <span>Target Device</span>
                                <select
                                    value={selCompTarget}
                                    onChange={(e) => {
                                        setSelCompTarget(e.target.value);
                                        if (companionError) setCompanionError("");
                                    }}
                                >
                                    {companionTargets.length === 0 ? (
                                        <option value="">No MQTT-enabled devices in this room</option>
                                    ) : (
                                        companionTargets.map((d) => (
                                            <option key={d.ip} value={d.ip}>
                                                {d.name} ({d.ip})
                                            </option>
                                        ))
                                    )}
                                </select>
                            </label>
                        )}

                        {inputCount > 1 && !lockInputSelection && (
                            <label className={style["dialog-field"]}>
                                <span>Link Input</span>
                                <select
                                    value={selCompInput}
                                    onChange={(e) => setSelCompInput(e.target.value)}
                                >
                                    {Array.from({ length: inputCount }, (_, n) => (
                                        <option key={n} value={String(n)}>
                                            Input {n}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {inputCount > 1 && lockInputSelection && (
                            <p className={style["dialog-note"]}>Link Input: {resolvedInputIndex}</p>
                        )}

                        {hasLocalRelay && selCompRoom !== GROUPS_ROOM_VALUE && (
                            <label className={style["dialog-check"]}>
                                <input
                                    type="checkbox"
                                    checked={detachLocal}
                                    onChange={(e) => setDetachLocal(e.target.checked)}
                                />
                                <span>Detach this device's own relay (recommended for a dedicated linked input)</span>
                            </label>
                        )}

                        {companionError && <p className={style.error}>{companionError}</p>}

                        <div className={style["dialog-actions"]}>
                            <button type="button" className={style["dialog-cancel"]} onClick={closeCompanionDialog} disabled={companionSubmitting}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={style["dialog-submit"]}
                                onClick={submitCompanion}
                                disabled={
                                    companionSubmitting ||
                                    (selCompRoom === GROUPS_ROOM_VALUE ? selCompGroup === "" : selCompTarget === "")
                                }
                            >
                                {companionSubmitting ? "Linking…" : "Link Device"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {showRoomDialog && (
                <div className={style["dialog-overlay"]} onClick={closeRoomDialog}>
                    <div className={style.dialog} onClick={(e) => e.stopPropagation()}>
                        <div className={style["dialog-header"]}>
                            <h4>Edit Room - {deviceEntity.name}</h4>
                            <button className={style["dialog-close"]} onClick={closeRoomDialog} aria-label="Close">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>

                        <label className={style["dialog-field"]}>
                            <span>Room</span>
                            <select
                                value={selRoomId}
                                onChange={(e) => {
                                    setSelRoomId(e.target.value);
                                    if (roomDialogError) setRoomDialogError("");
                                }}
                            >
                                {roomOptions.length === 0 ? (
                                    <option value="">No rooms available</option>
                                ) : (
                                    roomOptions.map((room) => (
                                        <option key={room.id} value={String(room.id)}>
                                            {room.name}
                                        </option>
                                    ))
                                )}
                            </select>
                        </label>

                        <p className={style["dialog-note"]}>
                            Current network: <b>{deviceEntity.device?.ssid || "unknown"}</b>. Changing WiFi will reboot the device.
                        </p>

                        <label className={style["dialog-field"]}>
                            <span>WiFi Network</span>
                            <select
                                value={selSsid}
                                onChange={(e) => {
                                    setSelSsid(e.target.value);
                                    if (wifiDialogError) setWifiDialogError("");
                                }}
                            >
                                {wifiCredentials.length === 0 ? (
                                    <option value="">No saved WiFi credentials</option>
                                ) : (
                                    wifiCredentials.map((cred) => (
                                        <option key={cred.id} value={cred.ssid}>
                                            {cred.ssid}
                                        </option>
                                    ))
                                )}
                            </select>
                        </label>

                        {wifiCredentials.length === 0 && (
                            <p className={style["dialog-note"]}>Add WiFi credentials in Site Configs first.</p>
                        )}

                        {roomDialogError && <p className={style.error}>{roomDialogError}</p>}
                        {wifiDialogError && <p className={style.error}>{wifiDialogError}</p>}

                        <div className={style["dialog-actions"]}>
                            <button type="button" className={style["dialog-cancel"]} onClick={closeRoomDialog} disabled={roomSubmitting}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={style["dialog-submit"]}
                                onClick={submitChangeWifi}
                                disabled={wifiSubmitting || wifiCredentials.length === 0}
                            >
                                {wifiSubmitting ? "Sending..." : "Change WiFi"}
                            </button>
                            <button
                                type="button"
                                className={style["dialog-submit"]}
                                onClick={submitRoomChange}
                                disabled={roomSubmitting || roomOptions.length === 0}
                            >
                                {roomSubmitting ? "Saving..." : "Save Room"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
};

export default ShellyEntity;
