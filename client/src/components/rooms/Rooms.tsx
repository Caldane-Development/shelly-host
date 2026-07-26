import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import style from "./rooms.module.css";
import { BACKEND_URL } from "../../constants/env";

interface Room {
    id: number;
    name: string;
    image: string;
    backgroundColor: string;
    mainSensor: boolean;
    overviewStyle: boolean;
    position: number;
    modified: string;
}

const Rooms = () => {
    const navigate = useNavigate();
    const [rooms, setRooms] = useState<Room[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        const fetchRooms = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/shelly/rooms`);
                if (!response.ok) {
                    throw new Error(`Request failed: ${response.status}`);
                }
                const data: Room[] = await response.json();
                setRooms(data);
            } catch (err) {
                console.error("Failed to fetch rooms", err);
                setError("Could not load rooms from the server.");
            } finally {
                setLoading(false);
            }
        };

        fetchRooms();
    }, []);

    return (
        <section className={style.rooms}>
            <h2>Rooms</h2>

            {loading ? (
                <p className={style.loading}>Loading rooms…</p>
            ) : error ? (
                <p className={style.loading}>{error}</p>
            ) : rooms.length === 0 ? (
                <div className={style.empty}>
                    <p>No rooms have been saved yet.</p>
                    <p>
                        Run the{" "}
                        <button className={style.link} onClick={() => navigate("/scanner")}>
                            Scanner
                        </button>{" "}
                        to discover devices and save their rooms.
                    </p>
                </div>
            ) : (
                <div className={style["room-grid"]}>
                    {rooms.map((room) => (
                        <article key={room.id} className={style.card}>
                            <span className={style.name}>{room.name}</span>
                            <span className={style.meta}>Position {room.position}</span>
                            {room.mainSensor && <span className={style.tag}>Main sensor</span>}
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
};

export default Rooms;
