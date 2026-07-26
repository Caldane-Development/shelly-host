import { Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import Layout from "./components/layout/Layout";
import Home from "./components/home/Home";
import IpAddressSetter from "./components/ip-address/IpAddressSetter";
import ShellyScanner from "./components/shelly-scanner/ShellyScanner";
import SiteConfigs from "./components/site-configs/SiteConfigs";
import MqttBrowser from "./components/mqtt-browser/MqttBrowser";
import Devices from "./components/devices/Devices";
import Rooms from "./components/rooms/Rooms";
import Groups from "./components/groups/Groups";

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
                <Route path="/rooms" element={<Rooms />} />
                <Route path="/groups" element={<Groups />} />
                <Route path="/mqtt-browser" element={<MqttBrowser />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default App;
