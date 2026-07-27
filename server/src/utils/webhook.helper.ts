import site from "../assets/json/site.json";
import { Hook } from "../../../common/models/webhooks.interface";
import { getSiteConfigCached } from "./site-config.helper";
import { logger } from "../logger";

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
export const createGroupWebhookConfig = (groupId: number, mode: "on" | "off", inputId: number = 0): Hook => {
    const base = getSiteConfigCached().webhook;
    const siteName = getSiteConfigCached().name;

    if (!base) {
        logger.info(
            `[server]: Site config 'webhook' host is empty; group ${groupId} webhook URL will be invalid. Set the webhook host in Site Config.`
        );
    }

    const hookMap = {
        "on": { id: 1, event: "input.toggle_on", name: `Group ${groupId} Toggle On` },
        "off": { id: 2, event: "input.toggle_off", name: `Group ${groupId} Toggle Off` },
    };

    return {
        "id": hookMap[mode].id,
        "cid": inputId,
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

// Webhook that makes a companion (3-way) switch toggle the relay on ANOTHER
// device. Each physical toggle edge calls the target device's Switch.Toggle
// directly, so one flip = one toggle regardless of the switch position.
export const createCompanionWebhookConfig = (
    targetIp: string,
    targetChannel: number,
    mode: "on" | "off",
    inputId: number = 0
): Hook => {
    const hookMap = {
        "on": { id: 1, event: "input.toggle_on", name: `Companion ${inputId} -> ${targetIp}` },
        "off": { id: 2, event: "input.toggle_off", name: `Companion ${inputId} -> ${targetIp}` },
    };

    return {
        "id": hookMap[mode].id,
        "cid": inputId,
        "enable": true,
        "event": hookMap[mode].event,
        "name": hookMap[mode].name,
        "ssl_ca": "ca.pem",
        "urls": [
            `http://${targetIp}/rpc/Switch.Toggle?id=${targetChannel}`
        ],
        "condition": null,
        "repeat_period": 0
    };
};
