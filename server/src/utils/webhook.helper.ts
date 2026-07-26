import site from "../assets/json/site.json";
import { Hook } from "../../../common/models/webhooks.interface";
import { getSiteConfigCached } from "./site-config.helper";

export const createWebhookConfig = (deviceName: string, room: number, clientName: string, mode: "on" | "off"): Hook => {
    const name = deviceName.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();

    const hookMap = {
        "on": {
            id: 1,
            event: "input.toggle_on",
            name: "Toggle Light On",
        },
        "off": {
            id: 2,
            event: "input.toggle_off",
            name: "Toggle Light Off",
        },
    }

    return {
        "id": hookMap[mode].id,
        "cid": 0,
        "enable": true,
        "event": hookMap[mode].event,
        "name": hookMap[mode].name,
        "ssl_ca": "ca.pem",
        "urls": [
            `http://${site.buffington.webhook}/api/message/srd/${site.buffington.name}/${room}/${name}/switch/message/toggle/${clientName}`
        ],
        "condition": null,
        "repeat_period": 0
    };
};

// Webhook that fires on either physical toggle edge and triggers a smart group.
// The group decides all-on vs all-off from live device state, so both edges
// point at the same trigger endpoint.
export const createGroupWebhookConfig = (groupId: number, mode: "on" | "off"): Hook => {
    const base = getSiteConfigCached().webhook;
    const siteName = getSiteConfigCached().name;

    const hookMap = {
        "on": { id: 1, event: "input.toggle_on", name: `Group ${groupId} Toggle On` },
        "off": { id: 2, event: "input.toggle_off", name: `Group ${groupId} Toggle Off` },
    };

    return {
        "id": hookMap[mode].id,
        "cid": 0,
        "enable": true,
        "event": hookMap[mode].event,
        "name": hookMap[mode].name,
        "ssl_ca": "ca.pem",
        "urls": [
            `http://${base}/api/group/${groupId}/trigger?site=${siteName}`
        ],
        "condition": null,
        "repeat_period": 0
    };
};
