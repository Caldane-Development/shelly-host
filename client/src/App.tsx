import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import "./App.css";
import Home from "./components/home/Home";
import IpAddressSetter from "./components/ip-address/IpAddressSetter";
import ShellyScanner from "./components/shelly-scanner/ShellyScanner";
import SiteConfigs from "./components/site-configs/SiteConfigs";
import MqttBrowser from "./components/mqtt-browser/MqttBrowser";
import Devices from "./components/devices/Devices";

export type View = "home" | "scanner" | "site-configs" | "devices" | "mqtt-browser";

function App() {
    const [view, setView] = useState<View>("home");

    if (view === "home") {
        return <Home onNavigate={setView} />;
    }

    const renderView = () => {
        switch (view) {
            case "scanner":
                return (
                    <>
                        <IpAddressSetter />
                        <ShellyScanner />
                    </>
                );
            case "site-configs":
                return <SiteConfigs />;
            case "devices":
                return <Devices onNavigate={setView} />;
            case "mqtt-browser":
                return <MqttBrowser />;
        }
    };

    return (
        <>
            <button onClick={() => setView("home")}>
                <FontAwesomeIcon icon={faArrowLeft} /> Home
            </button>
            {renderView()}
        </>
    );
}

export default App;
