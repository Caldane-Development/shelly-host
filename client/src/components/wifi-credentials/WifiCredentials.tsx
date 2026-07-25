import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrash, faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import style from "./wifi-credentials.module.css";
import { BACKEND_URL } from "../../constants/env";

interface WifiCredential {
    id: number;
    ssid: string;
    password: string;
}

const WifiCredentials = () => {
    const [credentials, setCredentials] = useState<WifiCredential[]>([]);
    const [ssid, setSsid] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [revealed, setRevealed] = useState<Record<number, boolean>>({});
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

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
            setError("Could not load WiFi credentials from the server.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCredentials();
    }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedSsid = ssid.trim();

        if (trimmedSsid === "") {
            setError("Enter a network name (SSID).");
            return;
        }
        if (password === "") {
            setError("Enter a password.");
            return;
        }

        try {
            const response = await fetch(`${BACKEND_URL}/wifi`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ssid: trimmedSsid, password }),
            });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            setSsid("");
            setPassword("");
            setShowPassword(false);
            setError("");
            await fetchCredentials();
        } catch (err) {
            console.error("Failed to save WiFi credential", err);
            setError("Could not save the WiFi credential.");
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const response = await fetch(`${BACKEND_URL}/wifi/${id}`, { method: "DELETE" });
            if (!response.ok) {
                throw new Error(`Request failed: ${response.status}`);
            }
            await fetchCredentials();
        } catch (err) {
            console.error("Failed to delete WiFi credential", err);
            setError("Could not delete the WiFi credential.");
        }
    };

    const toggleReveal = (id: number) => {
        setRevealed((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    return (
        <section className={style["wifi-credentials"]}>
            <h2>WiFi Credentials</h2>
            <div className={style.panel}>
                <p>Saved network names and passwords used to provision devices.</p>

                <form className={style["add-form"]} onSubmit={handleAdd}>
                    <input
                        type="text"
                        placeholder="Network name (SSID)"
                        value={ssid}
                        onChange={(e) => {
                            setSsid(e.target.value);
                            if (error) setError("");
                        }}
                    />
                    <div className={style["password-field"]}>
                        <input
                            type={showPassword ? "text" : "password"}
                            placeholder="Password"
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                if (error) setError("");
                            }}
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
                        <FontAwesomeIcon icon={faPlus} /> Save
                    </button>
                </form>
                {error && <p className={style.error}>{error}</p>}

                {loading ? (
                    <p className={style.empty}>Loading credentials…</p>
                ) : credentials.length === 0 ? (
                    <p className={style.empty}>No WiFi credentials saved yet.</p>
                ) : (
                    <ul className={style["credential-list"]}>
                        {credentials.map((cred) => (
                            <li key={cred.id}>
                                <div className={style.info}>
                                    <span className={style.ssid}>{cred.ssid}</span>
                                    <span className={style.password}>
                                        {revealed[cred.id] ? cred.password : "••••••••"}
                                    </span>
                                </div>
                                <div className={style.actions}>
                                    <button
                                        className={style["toggle-visibility"]}
                                        onClick={() => toggleReveal(cred.id)}
                                        aria-label={revealed[cred.id] ? "Hide password" : "Show password"}
                                    >
                                        <FontAwesomeIcon icon={revealed[cred.id] ? faEyeSlash : faEye} />
                                    </button>
                                    <button
                                        className={style.remove}
                                        onClick={() => handleDelete(cred.id)}
                                        aria-label={`Remove ${cred.ssid}`}
                                    >
                                        <FontAwesomeIcon icon={faTrash} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
};

export default WifiCredentials;
