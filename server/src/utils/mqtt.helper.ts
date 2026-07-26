import * as mqttLibrary from "mqtt";
import { logger } from "../logger";
import deviceList from "../assets/json/device-list.json";
import roomList from "../assets/json/room-list.json";
import { Room } from "../../../common/models/sites.interface";
import { MqttResult } from "../../../common/models/mqtt.interface";
import { Device, IDevice } from "../../../common/models/device.interface";
import { createIDevice } from "./device.helper";
import { getSiteConfigCached } from "./site-config.helper";

export interface SubscriptionResponse {
    id: string;
    src: string;
    dst: string
    result: StatusResult
}

export interface StatusResult {
    id: number
    source: string
    output: boolean
    temperature: Temperature
  }
  
  export interface Temperature {
    tC: number
    tF: number
  }
  

const STATUS_MESSAGE = {
    method: "Switch.GetStatus",
    params: {
        id: 0,
        on: false,
    },
} as const;

const listeners: ((device: IDevice) => void)[] = [];

export interface MqttMonitorMessage {
    topic: string;
    message: string;
    timestamp: string;
}

const monitors: Map<string, (message: MqttMonitorMessage) => void> = new Map();

const client = mqttLibrary.connect(process.env.MQTT_URL as string);
logger.info(`[server]: MQTT Server is running at ${process.env.MQTT_URL}`);

client.on("connect", () => {
    const siteName = getSiteConfigCached().name;
    client.subscribe([`${siteName}.status/rpc`, `${siteName}.action/rpc`], (err) => {
        if (err) {
            logger.error(`[server]: Failed to subscribe to MQTT channel: ${err}`);
        }
        logger.info(`[server]: Subscribed to MQTT channel: ${siteName}`);
    });

    // Subscribe to all topics so the MQTT browser can monitor broker traffic
    client.subscribe("#", (err) => {
        if (err) {
            logger.error(`[server]: Failed to subscribe to monitor channel: ${err}`);
            return;
        }
        logger.info(`[server]: Subscribed to monitor channel: #`);
    });
});

client.on("message", (topic, message) => {
    // Forward every message to any active monitors before other processing
    if (monitors.size > 0) {
        const monitorMessage: MqttMonitorMessage = {
            topic,
            message: message.toString(),
            timestamp: new Date().toISOString(),
        };
        monitors.forEach((monitor) => {
            try {
                monitor(monitorMessage);
            } catch (error) {
                logger.error(`[server]: Failed to forward MQTT message to monitor: ${error}`);
            }
        });
    }

    const [topicSite, topicChannel] = topic.split(".");

    if (message.length === 0) {
        return;
    }
    if (message.toString() === "0") {
        return;
    }

    if(topicSite !== getSiteConfigCached().name) {
        logger.error(`[server]: Invalid topic site: ${topicSite}`);
        return;
    }

    if(topicChannel === "action/rpc") {
        try {
            const parsedMessage = JSON.parse(message.toString());
            if (parsedMessage.src && typeof parsedMessage.src === "string") {
                const src: keyof typeof deviceList.data.devices = parsedMessage.src.split('-')[1].toLocaleLowerCase();
                const device: Device = deviceList.data.devices[src];
                mqtt.status(device);
            } else {
                logger.error(`[server]: Invalid message format, 'src' property missing or invalid.`);
            }
        } catch (error) {
            logger.error(`[server]: Failed to parse message: ${error}`);
        }
        logger.state(`[server]: Client ${topicSite} published message "${message.toString()}" to channel "${topic}"`);
    }

    if (topicChannel === "status/rpc") {
        listeners.forEach((listener) => {
            try {
                //{"id":123,"src":"shelly1minig3-5432045c8e7c","dst":"buffington","result":{"id":0, "source":"MQTT", "output":false,"temperature":{"tC":51.1, "tF":123.9}}}
                const statusResponse = JSON.parse(message.toString()) as SubscriptionResponse;
                const deviceId = statusResponse.src.split('-')[1].toLocaleLowerCase() as keyof typeof deviceList.data.devices;

                const device: IDevice = createIDevice(deviceList.data.devices[deviceId]);
                device.switchStatus.output = statusResponse.result.output;
                device.src = statusResponse.src;
                listener(device);
            } catch (error) {
                logger.error(`[server]: Failed to parse MQTT message: ${error}`);
            }
        });
    }
});

export const mqttAddListener = (id: string, callback: (device: IDevice) => void) => {
    listeners.push(callback);
    logger.info(`[server]: Added MQTT site listener: ${id}`);
};

export const mqttAddMonitor = (id: string, callback: (message: MqttMonitorMessage) => void) => {
    monitors.set(id, callback);
    logger.info(`[server]: Added MQTT monitor: ${id}`);
};

export const mqttRemoveMonitor = (id: string) => {
    monitors.delete(id);
    logger.info(`[server]: Removed MQTT monitor: ${id}`);
};

export const mqtt = {
    publish: (clientName: string, channel: string, message: string) => {
        client.publish(`${channel}/rpc`, message);
        logger.request(`[server]: Client ${clientName} published message "${message}" to channel "${channel}"`);
    },
    status: (device: Device) => {
        if(!device || !device.room_id) {
            logger.error(`[server]: Device or room_id is missing for device: ${device ? device.name : "Unknown"}`);
            return;
        }

        if (!roomList.data.rooms) {
            logger.error(`[server]: Room list is not available.`);
            return;
        }

        if (!device.name || !device.ip) {
            logger.error(`[server]: Device name or IP is missing for device: ${device ? device.name : "Unknown"}`);
            return;
        }

        const roomKey = device.room_id.toString() as keyof typeof roomList.data.rooms;
        const room: Room = roomList.data.rooms[roomKey];
        const mqttConfig = createMqttConfig(device.name, room);

        client.publish(`${mqttConfig.topic_prefix}/rpc`, JSON.stringify({ src: `${getSiteConfigCached().name}.status`, ...STATUS_MESSAGE, id: device.ip }));
        logger.request(`[server]: Client ${device.name} published [get status] to channel "${mqttConfig.topic_prefix}"`);
    },
};

export const createMqttConfig = (deviceName: string, deviceRoom: Room): MqttResult => {
    const siteConfig = getSiteConfigCached();
    const name = deviceName.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();
    const room = deviceRoom ? deviceRoom.name.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase() : "default";

    return {
        enable: true,
        server: siteConfig.mqtt,
        client_id: name,
        topic_prefix: `${siteConfig.name}/${room}/${name}/switch`,
        enable_rpc: true,
        enable_control: true,
        user: undefined,
        ssl_ca: undefined,
        rpc_ntf: false,
        status_ntf: false,
        use_client_cert: false,
        connected: true,
    };
};
