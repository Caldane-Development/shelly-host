import { Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import Layout from "./components/layout/Layout";
import Home from "./components/home/Home";
import IpAddressSetter from "./components/ip-address/IpAddressSetter";
import ShellyScanner from "./components/shelly-scanner/ShellyScanner";
import SiteConfigs from "./components/site-configs/SiteConfigs";
import MqttBrowser from "./components/mqtt-browser/MqttBrowser";
import Devices from "./components/devices/Devices";
import WifiCredentials from "./components/wifi-credentials/WifiCredentials";

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route element={<Layout />}>
                <Route
                    path="/scanner"
                    element={
                        <>
                            <IpAddressSetter />
                            <ShellyScanner />
                        </>
                    }
                />
                <Route path="/site-configs" element={<SiteConfigs />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/mqtt-browser" element={<MqttBrowser />} />
                <Route path="/wifi" element={<WifiCredentials />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default App;
