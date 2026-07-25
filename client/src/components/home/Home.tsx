import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWifi, faSitemap, faMicrochip, faTowerBroadcast } from "@fortawesome/free-solid-svg-icons";
import { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import style from "./home.module.css";
import { View } from "../../App";

interface Tile {
    view: View;
    label: string;
    description: string;
    icon: IconDefinition;
}

const tiles: Tile[] = [
    {
        view: "scanner",
        label: "Scanner",
        description: "Discover Shelly devices on your network",
        icon: faWifi,
    },
    {
        view: "site-configs",
        label: "Site Configs",
        description: "Manage site and room configuration",
        icon: faSitemap,
    },
    {
        view: "devices",
        label: "Devices",
        description: "View and manage registered devices",
        icon: faMicrochip,
    },
    {
        view: "mqtt-browser",
        label: "MQTT Browser",
        description: "Browse MQTT topics and messages",
        icon: faTowerBroadcast,
    },
];

interface HomeProps {
    onNavigate: (view: View) => void;
}

const Home = ({ onNavigate }: HomeProps) => {
    return (
        <section className={style.home}>
            <h1>Shelly Host</h1>
            <div className={style.tiles}>
                {tiles.map((tile) => (
                    <button
                        key={tile.view}
                        className={style.tile}
                        onClick={() => onNavigate(tile.view)}
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
