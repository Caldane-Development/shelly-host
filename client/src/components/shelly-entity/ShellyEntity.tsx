import { faCloudArrowUp, faCopy, faMessage, faObjectGroup, faPowerOff, faTowerBroadcast, faWifi, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useState } from "react";
import { IDevice } from "../../../../common/models/device.interface";
import { BACKEND_URL } from "../../constants/env";
import style from "./shelly-entity.module.css";

const TOGGLE_MESSAGE = { src: "buffington.action", method: "Switch.Toggle", params: { id: 0 } };

const slugify = (text: string) => text.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();

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

interface GroupOption {
    id: number;
    name: string;
    controllerDeviceId: string | null;
}

const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`**Copied to clipboard**\n${label}:\n${text}`);
};

const ShellyEntity = ({ device, mode }: { device: IDevice; mode: string }) => {
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
    const [showWifiDialog, setShowWifiDialog] = useState(false);
    const [wifiCredentials, setWifiCredentials] = useState<WifiCredential[]>([]);
    const [selSsid, setSelSsid] = useState("");
    const [wifiDialogError, setWifiDialogError] = useState("");
    const [wifiSubmitting, setWifiSubmitting] = useState(false);

    // Group-controller dialog state
    const [showGroupDialog, setShowGroupDialog] = useState(false);
    const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
    const [selGroup, setSelGroup] = useState<string>("");
    const [groupDialogError, setGroupDialogError] = useState("");
    const [groupSubmitting, setGroupSubmitting] = useState(false);

    useEffect(() => {
        setDeviceEntity(device);
        setDeviceName(device.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
    }, [device]);


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
            setDeviceEntity(data);
            setDeviceName(data.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
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
            setDeviceEntity(data);
            setDeviceName(data.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
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
            setDeviceEntity(data);
            setDeviceName(data.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase());
            closeDialog();
        } catch (err) {
            console.error("Failed to enable MQTT", err);
            setDialogError("Could not enable MQTT on the device.");
        } finally {
            setSubmitting(false);
        }
    };

    const openWifiDialog = async () => {
        setWifiDialogError("");
        setShowWifiDialog(true);
        try {
            const response = await fetch(`${BACKEND_URL}/wifi`);
            const creds: WifiCredential[] = response.ok ? await response.json() : [];
            setWifiCredentials(creds);
            setSelSsid(creds[0]?.ssid || "");
        } catch (err) {
            console.error("Failed to load WiFi credentials", err);
            setWifiDialogError("Could not load WiFi credentials from the server.");
        }
    };

    const closeWifiDialog = () => {
        setShowWifiDialog(false);
        setWifiDialogError("");
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
            closeWifiDialog();
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

    // Assign this device as the controller of a switch group. A physical event
    // on the device (button toggle) then triggers the whole group. The backend
    // installs the on/off webhooks on the device.
    const openGroupDialog = async () => {
        setGroupDialogError("");
        setShowGroupDialog(true);
        try {
            const response = await fetch(`${BACKEND_URL}/group`);
            const groups: GroupOption[] = response.ok ? await response.json() : [];
            setGroupOptions(groups);
            // Preselect a group this device already controls, if any.
            const deviceId = deviceEntity.device?.id?.toString() ?? "";
            const owned = groups.find((g) => g.controllerDeviceId === deviceId);
            setSelGroup(owned ? String(owned.id) : groups[0] ? String(groups[0].id) : "");
        } catch (err) {
            console.error("Failed to load groups", err);
            setGroupDialogError("Could not load switch groups from the server.");
        }
    };

    const closeGroupDialog = () => {
        setShowGroupDialog(false);
        setGroupDialogError("");
    };

    const submitGroupController = async () => {
        if (selGroup === "") {
            setGroupDialogError("Choose a switch group.");
            return;
        }
        const deviceId = deviceEntity.device?.id?.toString();
        if (!deviceId) {
            setGroupDialogError("This device has no id; re-run the scanner first.");
            return;
        }

        setGroupSubmitting(true);
        setGroupDialogError("");
        try {
            const response = await fetch(`${BACKEND_URL}/group/${selGroup}/controller`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deviceId }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            closeGroupDialog();
            const groupName = groupOptions.find((g) => String(g.id) === selGroup)?.name ?? selGroup;
            alert(`${deviceEntity.name} is now the controller for "${groupName}".`);
        } catch (err) {
            console.error("Failed to assign group controller", err);
            setGroupDialogError(
                "Could not assign this device as controller. Make sure it was picked up by a recent scan."
            );
        } finally {
            setGroupSubmitting(false);
        }
    };

    // Toggle the switch over MQTT by publishing to the device's topic prefix.
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

    return (
        <section className={style["shelly-entity"]} data-mqtt={deviceEntity.mqtt?.enable ? "" : undefined} data-ip={deviceEntity.ip}>
            <h3 onClick={() => window.open(`http://${deviceEntity.ip}`, "_blank")}>{deviceEntity.name}</h3>
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
                <b>State:</b> {deviceEntity?.switchStatus?.output ? "On" : "Off"}
            </p>
            <p>
                <b>WiFi:</b> {deviceEntity.device?.ssid || "N/A"}
            </p>
            <p>
                <b>MQTT Server:</b> {deviceEntity.mqtt?.server || "N/A"}
            </p>
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
                {(mode == "debug" || mode == "dev") && (
                    <button onClick={() => handleMqtt(deviceEntity)}>
                        <b>MQTT:</b> {deviceEntity.mqtt?.enable.toString()}
                    </button>
                )}
                {deviceEntity.mqtt?.enable && (
                    <button onClick={() => togglePower(deviceEntity)}>
                        <FontAwesomeIcon icon={faPowerOff} data-status={deviceEntity.switchStatus.output} />
                    </button>
                )}
                {mode === "normal" && !deviceEntity.mqtt?.enable && (
                    <button className={style["enable-mqtt"]} onClick={openDialog}>
                        <FontAwesomeIcon icon={faTowerBroadcast} /> Enable MQTT
                    </button>
                )}
                {mode === "normal" && (
                    <button className={style["change-wifi"]} onClick={openWifiDialog} title="Change WiFi network">
                        <FontAwesomeIcon icon={faWifi} /> Change WiFi
                    </button>
                )}
                {mode === "normal" && (
                    <button
                        className={style["change-wifi"]}
                        onClick={openGroupDialog}
                        title="Assign this device as a switch-group controller"
                    >
                        <FontAwesomeIcon icon={faObjectGroup} /> Group Controller
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
            {showWifiDialog && (
                <div className={style["dialog-overlay"]} onClick={closeWifiDialog}>
                    <div className={style.dialog} onClick={(e) => e.stopPropagation()}>
                        <div className={style["dialog-header"]}>
                            <h4>Change WiFi — {deviceEntity.name}</h4>
                            <button className={style["dialog-close"]} onClick={closeWifiDialog} aria-label="Close">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>

                        <p className={style["dialog-note"]}>
                            Current network: <b>{deviceEntity.device?.ssid || "unknown"}</b>. The device will reboot,
                            reconnect on the new network with a new IP, and drop off this list until you re-scan.
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
                            <p className={style["dialog-note"]}>
                                Add WiFi credentials in Site Configs first.
                            </p>
                        )}

                        {wifiDialogError && <p className={style.error}>{wifiDialogError}</p>}

                        <div className={style["dialog-actions"]}>
                            <button type="button" className={style["dialog-cancel"]} onClick={closeWifiDialog} disabled={wifiSubmitting}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={style["dialog-submit"]}
                                onClick={submitChangeWifi}
                                disabled={wifiSubmitting || wifiCredentials.length === 0}
                            >
                                {wifiSubmitting ? "Sending…" : "Change WiFi"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {showGroupDialog && (
                <div className={style["dialog-overlay"]} onClick={closeGroupDialog}>
                    <div className={style.dialog} onClick={(e) => e.stopPropagation()}>
                        <div className={style["dialog-header"]}>
                            <h4>Group Controller — {deviceEntity.name}</h4>
                            <button className={style["dialog-close"]} onClick={closeGroupDialog} aria-label="Close">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>

                        <p className={style["dialog-note"]}>
                            A physical event on <b>{deviceEntity.name}</b> will toggle the selected switch group.
                            The device's on/off webhooks are installed automatically.
                        </p>

                        <label className={style["dialog-field"]}>
                            <span>Switch Group</span>
                            <select
                                value={selGroup}
                                onChange={(e) => {
                                    setSelGroup(e.target.value);
                                    if (groupDialogError) setGroupDialogError("");
                                }}
                            >
                                {groupOptions.length === 0 ? (
                                    <option value="">No switch groups</option>
                                ) : (
                                    groupOptions.map((group) => (
                                        <option key={group.id} value={String(group.id)}>
                                            {group.name}
                                        </option>
                                    ))
                                )}
                            </select>
                        </label>

                        {groupOptions.length === 0 && (
                            <p className={style["dialog-note"]}>Create a switch group first on the Switch Groups page.</p>
                        )}

                        {groupDialogError && <p className={style.error}>{groupDialogError}</p>}

                        <div className={style["dialog-actions"]}>
                            <button type="button" className={style["dialog-cancel"]} onClick={closeGroupDialog} disabled={groupSubmitting}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={style["dialog-submit"]}
                                onClick={submitGroupController}
                                disabled={groupSubmitting || groupOptions.length === 0}
                            >
                                {groupSubmitting ? "Assigning…" : "Set as Controller"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
};

export default ShellyEntity;
