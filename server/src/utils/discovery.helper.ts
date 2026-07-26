import { cli } from "winston/lib/winston/config";
import config from "../assets/json/config.json";
import { logger } from "../logger";
import { postRequest } from "./http.helper";
import { DeviceList, IDevice } from "../../../common/models/device.interface";
import { MqttResult } from "../../../common/models/mqtt.interface";
import { ShellyStatus, ShellyStatusResult } from "../../../common/models/shelly.interface";
import { createMqttConfig } from "./mqtt.helper";
import { Webhooks } from "../../../common/models/webhooks.interface";
import { createWebhookConfig } from "./webhook.helper";


export const discoverShelly = async (ip: string): Promise<ShellyStatusResult | null> => {
    const options = {
        body: {
            id: 0,
            method: "Shelly.GetStatus",
        },
    };

    try {
        const postResponse = await postRequest<ShellyStatus>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return postResponse.result;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to discover device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellyCloudDevices = async (): Promise<any> => {
    const auth_key = process.env.SHELLY_CLOUD_AUTH_KEY;
    const postData = {
        auth_key: auth_key, // Use your actual auth key here
    };

    const postResponse = await postRequest<{}>(
        `${config.discover["cloud-access"].url}${config.discover["cloud-access"]["list-path"]}`,
        {
            "Content-Type": "application/x-www-form-urlencoded",
            Host: "shelly-89-eu.shelly.cloud",
        },
        postData
    );

    return postResponse;
};

export const shellyCloudRooms = async (): Promise<any> => {
    const auth_key = process.env.SHELLY_CLOUD_AUTH_KEY;
    const postData = {
        auth_key: auth_key, // Use your actual auth key here
    };

    const postResponse = await postRequest<{}>(
        `${config.discover["cloud-access"].url}${config.discover["cloud-access"]["room-list-path"]}`,
        {
            "Content-Type": "application/x-www-form-urlencoded",
            Host: "shelly-89-eu.shelly.cloud",
        },
        postData
    );

    return postResponse;
};

export const composeShellyDevice = async (
    ip: string,
    rooms: any,
    devices: DeviceList,
    requestComplete: (ip: string) => void,
    discoverSuccess: () => void
): Promise<IDevice | null> => {
    let response: IDevice | null = null;
    try {
        const device = await discoverShelly(ip);
        if (device === null) {
            logger.info(`[server]: Device at ${ip} is not reachable.`);
            return null;
        }
        const deviceInList = devices.data.devices[device.sys.mac.toLocaleLowerCase()];
        const enrichedDevice = {
            ...deviceInList,
            ip: device.wifi?.sta_ip || ip,
            ssid: device.wifi?.ssid || deviceInList.ssid,
        };
        response = {
            ip: ip,
            name: deviceInList.name,
            type: deviceInList.type,
            channel: "",
            mqtt: createMqttConfig(deviceInList.name, rooms.data.rooms[deviceInList.room_id]),
            room: deviceInList.room_id ? rooms.data.rooms[deviceInList.room_id] : null,
            switchStatus: device["switch:0"],
            device: enrichedDevice,
        }
        logger.info(`[server]: Discovered device at ${ip}: ${JSON.stringify(response.name)}`);
        discoverSuccess();
        return response;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to discover device at ${ip}. Error: ${error.message}`);
    } finally {
        requestComplete(ip);
    }

    return response;
};


export interface MqttActivateOverrides {
    server?: string;
    topicPrefix?: string;
}

export const shellyActivateMqtt = async (ip: string, device: any, overrides: MqttActivateOverrides = {}): Promise<IDevice | null> => {
    logger.info(`[server]: Activating MQTT for device with IP: ${ip}`, device);
    const mqttConfig: MqttResult = createMqttConfig(device.name, device.room);

    if (overrides.server) {
        mqttConfig.server = overrides.server;
    }
    if (overrides.topicPrefix) {
        mqttConfig.topic_prefix = overrides.topicPrefix;
    }

    const options = {
        body: {
            id: 0,
            method: "MQTT.SetConfig",
            params: {
                config: mqttConfig,
            },
        },
    };

    try {
        const postResponse = await postRequest<{}>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return {
            ip: ip,
            ...device,
            mqtt: mqttConfig,
        } as IDevice;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to activate MQTT on device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellyReboot = async (ip: string): Promise<any> => {
    const options = {
        body: {
            id: 0,
            method: "Shelly.Reboot",
        },
    };

    try {
        const postResponse = await postRequest<{}>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return postResponse;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to reboot device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellyGetMqttSettings = async (ip: string): Promise<any> => {
    const options = {
        body: {
            id: 0,
            method: "MQTT.GetConfig",
        },
    };

    try {
        const postResponse = await postRequest<{}>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return { ip: ip, ...postResponse };
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to get MQTT settings for device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellyWebhookList = async (ip: string): Promise<Webhooks | null> => {
    const options = {
        body: {
            id: ip,
            method: "Webhook.List",
        },
    };

    try {
        const postResponse = await postRequest<Webhooks>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return { ...postResponse, ip: ip };
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to get webhook list for device at ${ip}. Error: ${error.message}`);
    }

    return null;
}

export const shellyActivateWebhook = async (ip: string, device: IDevice, mode: "on" | "off"): Promise<any> => {
    if(!device || !device.room || !device.room.id || !device.device || !device.device.id) {
        logger.error(`[server]: Invalid device or room information for IP: ${ip}`);
        return null;
    }

    const roomId = device.room.id;
    const options = {
        body: {
            id: 0,
            method: device.webhooks ? "Webhook.Update" : "Webhook.Create",
            params: createWebhookConfig(device.name, roomId, device.device.id.toString(), mode),
        },
    };

    try {
        const postResponse = await postRequest<{}>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: "keep-alive",
            },
            options.body
        );
        return { ip: ip, ...postResponse };
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to activate webhook on device at ${ip}. Error: ${error.message}`);
    }

    return null;
}