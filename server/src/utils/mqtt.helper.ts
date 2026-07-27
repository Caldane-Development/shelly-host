import * as mqttLibrary from "mqtt";
import { logger } from "../logger";
import deviceList from "../assets/json/device-list.json";
import roomList from "../assets/json/room-list.json";
import { Room } from "../../../common/models/sites.interface";
import { MqttResult } from "../../../common/models/mqtt.interface";
import { Device, IDevice } from "../../../common/models/device.interface";
import { createIDevice } from "./device.helper";
import { getSiteConfigCached } from "./site-config.helper";
import { resolveBridgeTargets } from "./bridge.helper";
import { getMqttBrokerByServer } from "./mqtt-broker.helper";

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

export interface MqttMonitorStatus {
    broker: string;
    connected: boolean;
}

const monitors: Map<string, (message: MqttMonitorMessage) => void> = new Map();
let client: mqttLibrary.MqttClient | null = null;
let activeClientKey = "";
let activeBrokerLabel = "";
let mqttConnected = false;

const buildBrokerUrl = (server: string): string =>
    /^[a-z]+:\/\//i.test(server) ? server : `mqtt://${server}`;

const closeClient = async (mqttClient: mqttLibrary.MqttClient | null): Promise<void> => {
    if (!mqttClient) {
        return;
    }
    await new Promise<void>((resolve) => {
        mqttClient.end(true, {}, () => resolve());
    });
};

const subscribeMonitorTopics = (mqttClient: mqttLibrary.MqttClient, brokerLabel: string) => {
    mqttClient.subscribe("#", (err) => {
        if (err) {
            logger.error(`[server]: Failed to subscribe to monitor channel on ${brokerLabel}: ${err}`);
            return;
        }
        logger.info(`[server]: Subscribed to MQTT monitor channel on ${brokerLabel}: #`);
    });
};

const handleIncomingMessage = (topic: string, message: Buffer) => {
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

    // Switch-bridge handling: a controller device's NotifyStatus is mirrored
    // onto its linked target device(s) over MQTT (replaces outgoing webhooks).
    // Topics look like "{prefix}/events/rpc" and carry the source device id.
    if (topic.endsWith("/events/rpc") && message.length > 0) {
        try {
            const frame = JSON.parse(message.toString());
            if (frame.method === "NotifyStatus" && frame.src && frame.params) {
                for (const key of Object.keys(frame.params)) {
                    const match = key.match(/^switch:(\d+)$/);
                    if (!match) {
                        continue;
                    }
                    const output = frame.params[key]?.output;
                    if (typeof output !== "boolean") {
                        continue;
                    }
                    const channel = Number(match[1]);
                    const targets = resolveBridgeTargets(frame.src, channel, output);
                    targets.forEach((target) => {
                        const command = JSON.stringify({
                            id: 0,
                            src: `${getSiteConfigCached().name}.bridge`,
                            method: "Switch.Set",
                            params: { id: target.channel, on: target.on },
                        });
                        client?.publish(`${target.topicPrefix}/rpc`, command);
                        logger.request(
                            `[server]: Bridge mirrored ${frame.src} switch:${channel}=${output} -> ${target.targetName} (${target.topicPrefix})`
                        );
                    });
                }
            }
        } catch (error) {
            logger.error(`[server]: Failed to process bridge event: ${error}`);
        }
    }

    if (message.length === 0) {
        return;
    }
    if (message.toString() === "0") {
        return;
    }

    const [topicSite, ...topicChannelParts] = topic.split(".");
    if (topicSite !== getSiteConfigCached().name) {
        return;
    }

    const topicChannel = topicChannelParts.join(".");

    if (topicChannel === "action/rpc") {
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
};

const resolveBrokerConnection = async (): Promise<{
    key: string;
    url: string;
    options: mqttLibrary.IClientOptions;
    brokerLabel: string;
} | null> => {
    const configuredBroker = getSiteConfigCached().mqtt.trim();
    const fallbackBroker = (process.env.MQTT_URL ?? "").trim();
    const brokerLabel = configuredBroker || fallbackBroker;

    if (!brokerLabel) {
        return null;
    }

    const brokerUrl = buildBrokerUrl(brokerLabel);
    const savedBroker = configuredBroker ? await getMqttBrokerByServer(configuredBroker) : null;
    const options: mqttLibrary.IClientOptions = {};

    if (savedBroker?.username) {
        options.username = savedBroker.username;
    }
    if (savedBroker?.password) {
        options.password = savedBroker.password;
    }

    return {
        key: JSON.stringify({ url: brokerUrl, username: options.username ?? "", password: options.password ?? "" }),
        url: brokerUrl,
        options,
        brokerLabel,
    };
};

export const refreshMqttConnection = async (): Promise<void> => {
    const nextConnection = await resolveBrokerConnection();

    if (!nextConnection) {
        await closeClient(client);
        client = null;
        activeClientKey = "";
        activeBrokerLabel = "";
        mqttConnected = false;
        logger.warn("[server]: MQTT monitor disabled because no broker is configured");
        return;
    }

    if (client && activeClientKey === nextConnection.key) {
        return;
    }

    const previousClient = client;
    client = null;
    activeClientKey = nextConnection.key;
    activeBrokerLabel = nextConnection.brokerLabel;
    mqttConnected = false;
    await closeClient(previousClient);

    const nextClient = mqttLibrary.connect(nextConnection.url, nextConnection.options);
    client = nextClient;
    logger.info(`[server]: Connecting MQTT monitor to ${nextConnection.brokerLabel}`);

    nextClient.on("connect", () => {
        if (client !== nextClient) {
            return;
        }
        mqttConnected = true;
        logger.info(`[server]: MQTT monitor connected to ${nextConnection.brokerLabel}`);
        subscribeMonitorTopics(nextClient, nextConnection.brokerLabel);
    });

    nextClient.on("error", (error) => {
        if (client !== nextClient) {
            return;
        }
        mqttConnected = false;
        logger.error(`[server]: MQTT monitor error on ${nextConnection.brokerLabel}: ${error}`);
    });

    nextClient.on("close", () => {
        if (client !== nextClient) {
            return;
        }
        mqttConnected = false;
        logger.warn(`[server]: MQTT monitor disconnected from ${nextConnection.brokerLabel}`);
    });

    nextClient.on("message", handleIncomingMessage);
};

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

export const getMqttMonitorStatus = (): MqttMonitorStatus => ({
    broker: activeBrokerLabel,
    connected: mqttConnected,
});

export const mqtt = {
    publish: (clientName: string, channel: string, message: string) => {
        if (!client) {
            logger.error(`[server]: MQTT publish skipped for ${clientName}; no broker connection is active`);
            return;
        }
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

        if (!client) {
            logger.error(`[server]: MQTT status request skipped for ${device.name}; no broker connection is active`);
            return;
        }

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
