import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlay, faPause, faTrash } from "@fortawesome/free-solid-svg-icons";
import style from "./mqtt-browser.module.css";
import { BACKEND_URL } from "../../constants/env";

interface MqttMessage {
    topic: string;
    message: string;
    timestamp: string;
}

const MAX_MESSAGES = 500;

const formatPayload = (payload: string): string => {
    try {
        return JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
        return payload;
    }
};

const MqttBrowser = () => {
    const [messages, setMessages] = useState<MqttMessage[]>([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(false);
    const [paused, setPaused] = useState(false);
    const [filter, setFilter] = useState("");
    const pausedRef = useRef(paused);

    useEffect(() => {
        pausedRef.current = paused;
    }, [paused]);

    useEffect(() => {
        const eventSource = new EventSource(`${BACKEND_URL}/message/monitor`);

        eventSource.onopen = () => {
            setConnected(true);
            setError(false);
        };

        eventSource.onmessage = (event) => {
            if (pausedRef.current) {
                return;
            }
            try {
                const data: MqttMessage = JSON.parse(event.data);
                setMessages((prev) => [data, ...prev].slice(0, MAX_MESSAGES));
            } catch (err) {
                console.error("Failed to parse MQTT monitor message", err);
            }
        };

        eventSource.onerror = () => {
            setConnected(false);
            setError(true);
        };

        return () => {
            eventSource.close();
        };
    }, []);

    const filtered = filter
        ? messages.filter((m) => m.topic.toLowerCase().includes(filter.toLowerCase()))
        : messages;

    const statusClass = error
        ? `${style.status} ${style.error}`
        : connected
        ? `${style.status} ${style.connected}`
        : style.status;

    return (
        <section className={style["mqtt-browser"]}>
            <h2>MQTT Browser</h2>

            <div className={style.toolbar}>
                <span className={statusClass}>
                    <span className={style.dot} />
                    {error ? "Disconnected" : connected ? "Connected" : "Connecting…"}
                </span>
                <input
                    type="text"
                    className={style.filter}
                    placeholder="Filter by topic…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <button onClick={() => setPaused((p) => !p)}>
                    <FontAwesomeIcon icon={paused ? faPlay : faPause} /> {paused ? "Resume" : "Pause"}
                </button>
                <button onClick={() => setMessages([])}>
                    <FontAwesomeIcon icon={faTrash} /> Clear
                </button>
            </div>

            <div className={style.messages}>
                {filtered.length === 0 ? (
                    <p className={style.empty}>
                        {messages.length === 0 ? "Waiting for messages…" : "No messages match the filter."}
                    </p>
                ) : (
                    filtered.map((msg, index) => (
                        <div key={`${msg.timestamp}-${index}`} className={style.message}>
                            <div className={style.meta}>
                                <span className={style.topic}>{msg.topic}</span>
                                <span className={style.time}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <pre className={style.payload}>{formatPayload(msg.message)}</pre>
                        </div>
                    ))
                )}
            </div>
        </section>
    );
};

export default MqttBrowser;
