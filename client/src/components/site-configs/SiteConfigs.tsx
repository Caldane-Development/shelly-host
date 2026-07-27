import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrash, faEye, faEyeSlash, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import style from "./site-configs.module.css";
import { RootState } from "../../store/store";
import { addNetwork, removeNetwork } from "../../store/scannerSlice";
import { BACKEND_URL } from "../../constants/env";

// IPv4 regex (accepts any valid IPv4, e.g. a network address like 10.10.9.0)
const ipRegex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

interface MqttBroker {
    id: number;
    server: string;
    username: string;
    password: string;
}

interface WifiCredential {
    id: number;
    ssid: string;
    password: string;
}

const SiteConfigs = () => {
    const dispatch = useDispatch();
    const networks = useSelector((state: RootState) => state.scanner.networks);
    const [inputValue, setInputValue] = useState("");
    const [error, setError] = useState("");

    // Site config state
    const [siteName, setSiteName] = useState("");
    const [siteMqtt, setSiteMqtt] = useState("");
    // Host:port the Shelly devices call back to when an input toggles (group triggers).
    const [siteWebhook, setSiteWebhook] = useState("");
    const [siteLoading, setSiteLoading] = useState(true);
    const [siteError, setSiteError] = useState("");
    const [siteSaved, setSiteSaved] = useState(false);
    // Shelly cloud auth key. The server returns only a masked hint (e.g. ****6668);
    // the input stays empty and we only send a new value when the user types one,
    // so saving other fields never overwrites the stored key with the mask.
    const [siteCloudKey, setSiteCloudKey] = useState("");
    const [siteCloudKeyHint, setSiteCloudKeyHint] = useState("");
    const [showCloudKey, setShowCloudKey] = useState(false);

    // MQTT broker state
    const [brokers, setBrokers] = useState<MqttBroker[]>([]);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [server, setServer] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [revealed, setRevealed] = useState<Record<number, boolean>>({});
    const [brokerError, setBrokerError] = useState("");
    const [brokerLoading, setBrokerLoading] = useState(true);

    // WiFi credential state
    const [credentials, setCredentials] = useState<WifiCredential[]>([]);
    const [ssid, setSsid] = useState("");
    const [wifiPassword, setWifiPassword] = useState("");
    const [showWifiPassword, setShowWifiPassword] = useState(false);
    const [wifiRevealed, setWifiRevealed] = useState<Record<number, boolean>>({});
    const [wifiError, setWifiError] = useState("");
    const [wifiLoading, setWifiLoading] = useState(true);
    const [availableSsids, setAvailableSsids] = useState<string[]>([]);
    const [showPicker, setShowPicker] = useState(false);
    const [scanning, setScanning] = useState(false);

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        const value = inputValue.trim();

        if (!ipRegex.test(value)) {
            setError("Enter a valid IPv4 network address, e.g. 10.10.9.0");
            return;
        }
        if (networks.includes(value)) {
            setError("That network has already been added.");
            return;
        }

        dispatch(addNetwork(value));
        setInputValue("");
        setError("");
    };

    const fetchBrokers = async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/mqtt-broker`);
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: MqttBroker[] = await response.json();
            setBrokers(data);
        } catch (err) {
            console.error("Failed to fetch MQTT brokers", err);
            setBrokerError("Could not load MQTT brokers from the server.");
        } finally {
            setBrokerLoading(false);
        }
    };

    const fetchSuggestions = async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/mqtt-broker/available`);
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: string[] = await response.json();
            setSuggestions(data);
        } catch (err) {
            console.error("Failed to fetch broker suggestions", err);
        }
    };

    useEffect(() => {
        fetchBrokers();
        fetchSuggestions();
        fetchCredentials();
        fetchSiteConfig();
    }, []);

    const fetchSiteConfig = async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/site-config`);
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: { name: string; mqtt: string; webhook?: string; cloudAuthKey?: string } = await response.json();
            setSiteName(data.name ?? "");
            setSiteMqtt(data.mqtt ?? "");
            setSiteWebhook(data.webhook ?? "");
            setSiteCloudKeyHint(data.cloudAuthKey ?? "");
        } catch (err) {
            console.error("Failed to fetch site config", err);
            setSiteError("Could not load site config from the server.");
        } finally {
            setSiteLoading(false);
        }
    };

    const handleSaveSite = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedName = siteName.trim();

        if (trimmedName === "") {
            setSiteError("Enter a site name.");
            return;
        }

        try {
            const trimmedCloudKey = siteCloudKey.trim();
            const response = await fetch(`${BACKEND_URL}/site-config`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: trimmedName,
                    mqtt: siteMqtt.trim(),
                    webhook: siteWebhook.trim(),
                    // Only send the key when the user actually entered one, so we
                    // never persist the masked hint back over the real key.
                    ...(trimmedCloudKey !== "" ? { cloudAuthKey: trimmedCloudKey } : {}),
                }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: { name: string; mqtt: string; webhook?: string; cloudAuthKey?: string } = await response.json();
            setSiteName(data.name ?? "");
            setSiteMqtt(data.mqtt ?? "");
            setSiteWebhook(data.webhook ?? "");
            setSiteCloudKeyHint(data.cloudAuthKey ?? "");
            setSiteCloudKey("");
            setSiteError("");
            setSiteSaved(true);
            setTimeout(() => setSiteSaved(false), 2000);
        } catch (err) {
            console.error("Failed to save site config", err);
            setSiteError("Could not save the site config.");
        }
    };

    const fetchCredentials = async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/wifi`);
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: WifiCredential[] = await response.json();
            setCredentials(data);
        } catch (err) {
            console.error("Failed to fetch WiFi credentials", err);
            setWifiError("Could not load WiFi credentials from the server.");
        } finally {
            setWifiLoading(false);
        }
    };

    const handleSearchSsids = async () => {
        if (showPicker) {
            setShowPicker(false);
            return;
        }
        setScanning(true);
        setWifiError("");
        try {
            const response = await fetch(`${BACKEND_URL}/wifi/available`);
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            const data: string[] = await response.json();
            setAvailableSsids(data);
            setShowPicker(true);
        } catch (err) {
            console.error("Failed to fetch available SSIDs", err);
            setWifiError("Could not load available networks.");
        } finally {
            setScanning(false);
        }
    };

    const handleSelectSsid = (selected: string) => {
        setSsid(selected);
        setShowPicker(false);
        if (wifiError) setWifiError("");
    };

    const handleAddWifi = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedSsid = ssid.trim();

        if (trimmedSsid === "") {
            setWifiError("Enter a network name (SSID).");
            return;
        }
        if (wifiPassword === "") {
            setWifiError("Enter a password.");
            return;
        }

        try {
            const response = await fetch(`${BACKEND_URL}/wifi`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ssid: trimmedSsid, password: wifiPassword }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            setSsid("");
            setWifiPassword("");
            setShowWifiPassword(false);
            setWifiError("");
            await fetchCredentials();
        } catch (err) {
            console.error("Failed to save WiFi credential", err);
            setWifiError("Could not save the WiFi credential.");
        }
    };

    const handleDeleteWifi = async (id: number) => {
        try {
            const response = await fetch(`${BACKEND_URL}/wifi/${id}`, { method: "DELETE" });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            await fetchCredentials();
        } catch (err) {
            console.error("Failed to delete WiFi credential", err);
            setWifiError("Could not delete the WiFi credential.");
        }
    };

    const toggleWifiReveal = (id: number) => {
        setWifiRevealed((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    const handleSelectSuggestion = (value: string) => {
        setServer(value);
        if (brokerError) setBrokerError("");
    };

    const handleAddBroker = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedServer = server.trim();

        if (trimmedServer === "") {
            setBrokerError("Enter a broker address, e.g. perceptor.local:1884");
            return;
        }

        try {
            const response = await fetch(`${BACKEND_URL}/mqtt-broker`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ server: trimmedServer, username: username.trim(), password }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            setServer("");
            setUsername("");
            setPassword("");
            setShowPassword(false);
            setBrokerError("");
            await fetchBrokers();
        } catch (err) {
            console.error("Failed to save MQTT broker", err);
            setBrokerError("Could not save the MQTT broker.");
        }
    };

    const handleDeleteBroker = async (id: number) => {
        try {
            const response = await fetch(`${BACKEND_URL}/mqtt-broker/${id}`, { method: "DELETE" });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            await fetchBrokers();
        } catch (err) {
            console.error("Failed to delete MQTT broker", err);
            setBrokerError("Could not delete the MQTT broker.");
        }
    };

    const toggleReveal = (id: number) => {
        setRevealed((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    const savedServers = new Set(brokers.map((broker) => broker.server));

    return (
        <section className={style["site-configs"]}>
            <h2>Site Configs</h2>
            <div className={style.grid}>
            <div className={style.panel}>
                <h3 className={style["panel-title"]}>Site</h3>
                <p>The site name and default MQTT broker used to build device topics.</p>

                {siteLoading ? (
                    <p className={style.empty}>Loading site config…</p>
                ) : (
                    <form className={style["broker-form"]} onSubmit={handleSaveSite}>
                        <input
                            type="text"
                            placeholder="Site name, e.g. buffington"
                            value={siteName}
                            onChange={(e) => {
                                setSiteName(e.target.value);
                                if (siteError) setSiteError("");
                            }}
                            className={siteError ? style.invalid : undefined}
                        />
                        <select
                            value={siteMqtt}
                            onChange={(e) => setSiteMqtt(e.target.value)}
                        >
                            <option value="">No default broker</option>
                            {brokers.map((broker) => (
                                <option key={broker.id} value={broker.server}>
                                    {broker.server}
                                </option>
                            ))}
                            {siteMqtt && !brokers.some((b) => b.server === siteMqtt) && (
                                <option value={siteMqtt}>{siteMqtt}</option>
                            )}
                        </select>
                        <input
                            type="text"
                            placeholder="Webhook host, e.g. 10.10.10.28:4501"
                            value={siteWebhook}
                            onChange={(e) => {
                                setSiteWebhook(e.target.value);
                                if (siteError) setSiteError("");
                            }}
                        />
                        <div className={style["password-field"]}>
                            <input
                                type={showCloudKey ? "text" : "password"}
                                placeholder={siteCloudKeyHint ? `Shelly cloud key (current: ${siteCloudKeyHint})` : "Shelly cloud auth key"}
                                value={siteCloudKey}
                                onChange={(e) => {
                                    setSiteCloudKey(e.target.value);
                                    if (siteError) setSiteError("");
                                }}
                                autoComplete="off"
                            />
                            <button
                                type="button"
                                className={style["toggle-visibility"]}
                                onClick={() => setShowCloudKey((v) => !v)}
                                aria-label={showCloudKey ? "Hide cloud key" : "Show cloud key"}
                            >
                                <FontAwesomeIcon icon={showCloudKey ? faEyeSlash : faEye} />
                            </button>
                        </div>
                        <button type="submit">
                            <FontAwesomeIcon icon={faPlus} /> Save Site
                        </button>
                    </form>
                )}
                {siteSaved && <p className={style["network-name"]}>Saved.</p>}
                {siteError && <p className={style.error}>{siteError}</p>}
            </div>

            <div className={style.panel}>
                <h3 className={style["panel-title"]}>WiFi Credentials</h3>
                <p>Saved network names and passwords used to provision devices.</p>

                {wifiLoading ? (
                    <p className={style.empty}>Loading credentials…</p>
                ) : credentials.length === 0 ? (
                    <p className={style.empty}>No WiFi credentials saved yet.</p>
                ) : (
                    <ul className={style["network-list"]}>
                        {credentials.map((cred) => (
                            <li key={cred.id}>
                                <div className={style["broker-info"]}>
                                    <span className={style["network-name"]}>{cred.ssid}</span>
                                    <span className={style["broker-meta"]}>
                                        {wifiRevealed[cred.id] ? cred.password : "••••••••"}
                                    </span>
                                </div>
                                <div className={style["broker-actions"]}>
                                    <button
                                        className={style["toggle-visibility"]}
                                        onClick={() => toggleWifiReveal(cred.id)}
                                        aria-label={wifiRevealed[cred.id] ? "Hide password" : "Show password"}
                                    >
                                        <FontAwesomeIcon icon={wifiRevealed[cred.id] ? faEyeSlash : faEye} />
                                    </button>
                                    <button
                                        className={style.remove}
                                        onClick={() => handleDeleteWifi(cred.id)}
                                        aria-label={`Remove ${cred.ssid}`}
                                    >
                                        <FontAwesomeIcon icon={faTrash} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                <form className={style["broker-form"]} onSubmit={handleAddWifi}>
                    <div className={style["ssid-field"]}>
                        <button
                            type="button"
                            className={style["search-ssid"]}
                            onClick={handleSearchSsids}
                            disabled={scanning}
                            aria-label="Search available networks"
                            title="Search available networks"
                        >
                            <FontAwesomeIcon icon={faMagnifyingGlass} />
                        </button>
                        <input
                            type="text"
                            placeholder="Network name (SSID)"
                            value={ssid}
                            onChange={(e) => {
                                setSsid(e.target.value);
                                if (wifiError) setWifiError("");
                            }}
                        />
                        {showPicker && (
                            <ul className={style["ssid-picker"]}>
                                {availableSsids.length === 0 ? (
                                    <li className={style["ssid-picker-empty"]}>
                                        No networks found from discovered devices.
                                    </li>
                                ) : (
                                    availableSsids.map((name) => (
                                        <li key={name}>
                                            <button type="button" onClick={() => handleSelectSsid(name)}>
                                                {name}
                                            </button>
                                        </li>
                                    ))
                                )}
                            </ul>
                        )}
                    </div>
                    <div className={style["password-field"]}>
                        <input
                            type={showWifiPassword ? "text" : "password"}
                            placeholder="Password"
                            value={wifiPassword}
                            onChange={(e) => {
                                setWifiPassword(e.target.value);
                                if (wifiError) setWifiError("");
                            }}
                        />
                        <button
                            type="button"
                            className={style["toggle-visibility"]}
                            onClick={() => setShowWifiPassword((v) => !v)}
                            aria-label={showWifiPassword ? "Hide password" : "Show password"}
                        >
                            <FontAwesomeIcon icon={showWifiPassword ? faEyeSlash : faEye} />
                        </button>
                    </div>
                    <button type="submit">
                        <FontAwesomeIcon icon={faPlus} /> Save
                    </button>
                </form>
                {wifiError && <p className={style.error}>{wifiError}</p>}
            </div>

            <div className={style.panel}>
                <h3 className={style["panel-title"]}>Network Ranges</h3>
                <p>Networks the scanner is allowed to scan.</p>

                <form className={style["add-form"]} onSubmit={handleAdd}>
                    <input
                        type="text"
                        placeholder="e.g. 10.10.9.0"
                        value={inputValue}
                        onChange={(e) => {
                            setInputValue(e.target.value);
                            if (error) setError("");
                        }}
                        className={error ? style.invalid : undefined}
                    />
                    <button type="submit">
                        <FontAwesomeIcon icon={faPlus} /> Add
                    </button>
                </form>
                {error && <p className={style.error}>{error}</p>}

                {networks.length === 0 ? (
                    <p className={style.empty}>No networks configured yet.</p>
                ) : (
                    <ul className={style["network-list"]}>
                        {networks.map((network) => (
                            <li key={network}>
                                <span className={style["network-name"]}>{network}</span>
                                <button
                                    className={style.remove}
                                    onClick={() => dispatch(removeNetwork(network))}
                                    aria-label={`Remove ${network}`}
                                >
                                    <FontAwesomeIcon icon={faTrash} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className={style.panel}>
                <h3 className={style["panel-title"]}>MQTT Brokers</h3>
                <p>Broker connection details saved for provisioning devices.</p>

                {suggestions.length > 0 && (
                    <div className={style.suggestions}>
                        <p className={style["suggestions-label"]}>Brokers found on your devices:</p>
                        <div className={style["suggestion-chips"]}>
                            {suggestions.map((suggestion) => (
                                <button
                                    key={suggestion}
                                    type="button"
                                    className={style.chip}
                                    onClick={() => handleSelectSuggestion(suggestion)}
                                    disabled={savedServers.has(suggestion)}
                                    title={savedServers.has(suggestion) ? "Already saved" : "Use this broker"}
                                >
                                    {suggestion}
                                    {savedServers.has(suggestion) ? " ✓" : ""}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {brokerLoading ? (
                    <p className={style.empty}>Loading brokers…</p>
                ) : brokers.length === 0 ? (
                    <p className={style.empty}>No MQTT brokers saved yet.</p>
                ) : (
                    <ul className={style["network-list"]}>
                        {brokers.map((broker) => (
                            <li key={broker.id}>
                                <div className={style["broker-info"]}>
                                    <span className={style["network-name"]}>{broker.server}</span>
                                    {broker.username && (
                                        <span className={style["broker-meta"]}>
                                            {broker.username} /{" "}
                                            {revealed[broker.id] ? broker.password || "(no password)" : "••••••••"}
                                        </span>
                                    )}
                                </div>
                                <div className={style["broker-actions"]}>
                                    {broker.username && (
                                        <button
                                            className={style["toggle-visibility"]}
                                            onClick={() => toggleReveal(broker.id)}
                                            aria-label={revealed[broker.id] ? "Hide password" : "Show password"}
                                        >
                                            <FontAwesomeIcon icon={revealed[broker.id] ? faEyeSlash : faEye} />
                                        </button>
                                    )}
                                    <button
                                        className={style.remove}
                                        onClick={() => handleDeleteBroker(broker.id)}
                                        aria-label={`Remove ${broker.server}`}
                                    >
                                        <FontAwesomeIcon icon={faTrash} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                <form className={style["broker-form"]} onSubmit={handleAddBroker}>
                    <input
                        type="text"
                        placeholder="Broker address, e.g. perceptor.local:1884"
                        value={server}
                        onChange={(e) => {
                            setServer(e.target.value);
                            if (brokerError) setBrokerError("");
                        }}
                        className={brokerError ? style.invalid : undefined}
                    />
                    <input
                        type="text"
                        placeholder="Username (optional)"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                    <div className={style["password-field"]}>
                        <input
                            type={showPassword ? "text" : "password"}
                            placeholder="Password (optional)"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <button
                            type="button"
                            className={style["toggle-visibility"]}
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                        >
                            <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} />
                        </button>
                    </div>
                    <button type="submit">
                        <FontAwesomeIcon icon={faPlus} /> Save Broker
                    </button>
                </form>
                {brokerError && <p className={style.error}>{brokerError}</p>}
            </div>
            </div>
        </section>
    );
};

export default SiteConfigs;
