import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWifi, faSitemap, faMicrochip, faTowerBroadcast, faKey } from "@fortawesome/free-solid-svg-icons";
import { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { useNavigate } from "react-router-dom";
import style from "./home.module.css";

interface Tile {
    path: string;
    label: string;
    description: string;
    icon: IconDefinition;
}

const tiles: Tile[] = [
    {
        path: "/scanner",
        label: "Scanner",
        description: "Discover Shelly devices on your network",
        icon: faWifi,
    },
    {
        path: "/site-configs",
        label: "Site Configs",
        description: "Manage site and room configuration",
        icon: faSitemap,
    },
    {
        path: "/devices",
        label: "Devices",
        description: "View and manage registered devices",
        icon: faMicrochip,
    },
    {
        path: "/mqtt-browser",
        label: "MQTT Browser",
        description: "Browse MQTT topics and messages",
        icon: faTowerBroadcast,
    },
    {
        path: "/wifi",
        label: "WiFi Credentials",
        description: "Save network names and passwords",
        icon: faKey,
    },
];

const Home = () => {
    const navigate = useNavigate();

    return (
        <section className={style.home}>
            <h1>Shelly Host</h1>
            <div className={style.tiles}>
                {tiles.map((tile) => (
                    <button
                        key={tile.path}
                        className={style.tile}
                        onClick={() => navigate(tile.path)}
                    >
                        <FontAwesomeIcon icon={tile.icon} className={style.icon} />
                        <span className={style.label}>{tile.label}</span>
                        <span className={style.description}>{tile.description}</span>
                    </button>
                ))}
            </div>
        </section>
    );
};

export default Home;
