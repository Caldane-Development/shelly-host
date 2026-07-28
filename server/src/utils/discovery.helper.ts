import { cli } from "winston/lib/winston/config";
import config from "../assets/json/config.json";
import deviceOverridesJson from "../assets/json/device-overrides.json";
import { logger } from "../logger";
import { getRequest, postRequest } from "./http.helper";
import { DeviceList, IDevice } from "../../../common/models/device.interface";
import { MqttResult } from "../../../common/models/mqtt.interface";
import { ShellyStatus, ShellyStatusResult } from "../../../common/models/shelly.interface";
import { createMqttConfig } from "./mqtt.helper";
import { Webhooks } from "../../../common/models/webhooks.interface";
import { createWebhookConfig, createGroupWebhookConfig, createCompanionWebhookConfig } from "./webhook.helper";
import { getSiteConfigCached } from "./site-config.helper";

interface ShellyRpcRequestOptions {
    retries?: number;
    delayMs?: number;
    timeoutMs?: number;
    connectionHeader?: "keep-alive" | "close";
}

interface ShellyRpcError {
    code: number;
    message: string;
}

interface ShellyUpdateInfo {
    version?: string;
    build_id?: string;
    [key: string]: unknown;
}

interface ShellyUpdateCheckResult {
    stable?: ShellyUpdateInfo;
    beta?: ShellyUpdateInfo;
    alt?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ShellyRpcResponse<T = Record<string, unknown>> {
    id: number | string;
    src: string;
    dst: string;
    result?: T;
    error?: ShellyRpcError;
}


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

interface ShellyDeviceInfo {
    name: string | null;
    id: string;
    mac: string;
    model?: string;
}

// Per-device manual corrections, keyed by lowercase MAC. Some attributes (most
// notably the room) live only in the Shelly Smart Control app and are not
// exposed by the device itself or the legacy cloud catalog, so we allow a
// server-side override to bring discovery in line with what the user sees in
// the app. Only fields present in the override are applied.
interface DeviceOverride {
    name?: string;
    roomId?: number;
    note?: string;
}
const deviceOverrides: Record<string, DeviceOverride> = deviceOverridesJson;

// Read the name configured on the device itself (Shelly.GetDeviceInfo). This is
// the authoritative display name — it reflects what the user set on the device,
// independent of any cloud account. Best-effort: returns null on failure so it
// never breaks discovery.
export const shellyDeviceInfo = async (ip: string): Promise<ShellyDeviceInfo | null> => {
    try {
        return await getRequest<ShellyDeviceInfo>(`http://${ip}/rpc/Shelly.GetDeviceInfo`, {
            Accept: "application/json",
            "User-Agent": "ShellyApp/1.0",
        });
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to read device info at ${ip}. Error: ${error.message}`);
        return null;
    }
};

export const shellyCloudDevices = async (): Promise<any> => {
    const auth_key = getSiteConfigCached().cloudAuthKey;
    const postData = {
        auth_key: auth_key, // sourced from site config (DB)
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
    const auth_key = getSiteConfigCached().cloudAuthKey;
    const postData = {
        auth_key: auth_key, // sourced from site config (DB)
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
        const mac = device.sys.mac.toLocaleLowerCase();
        const deviceInList = devices.data.devices[mac];
        const override = deviceOverrides[mac];
        // Prefer the name set on the device itself over the cloud catalog name.
        // The on-device name reflects what the user configured (e.g. "Wetbar 1")
        // and is independent of any cloud account; fall back to the manual
        // override, then the catalog name when the device has no name set.
        const deviceInfo = await shellyDeviceInfo(ip);
        const displayName = deviceInfo?.name?.trim() || override?.name || deviceInList?.name;
        // The room only exists in the Shelly app, so honour a manual override
        // before falling back to the catalog's room assignment.
        const effectiveRoomId = override?.roomId ?? deviceInList?.room_id;
        const enrichedDevice = {
            ...deviceInList,
            name: displayName,
            room_id: effectiveRoomId,
            ip: device.wifi?.sta_ip || ip,
            ssid: device.wifi?.ssid || deviceInList?.ssid,
        };
        response = {
            ip: ip,
            name: displayName,
            type: deviceInList?.type,
            channel: "",
            mqtt: createMqttConfig(deviceInList?.name, rooms.data.rooms[effectiveRoomId]),
            room: effectiveRoomId ? rooms.data.rooms[effectiveRoomId] : null,
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

export const shellySetWifi = async (ip: string, ssid: string, password: string): Promise<any> => {
    logger.info(`[server]: Setting WiFi for device at ${ip} to SSID: ${ssid}`);
    const options = {
        body: {
            id: 0,
            method: "WiFi.SetConfig",
            params: {
                config: {
                    sta: {
                        ssid,
                        pass: password,
                        enable: true,
                    },
                },
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
        return { ip, ...postResponse };
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to set WiFi on device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellySetSwitch = async (ip: string, on: boolean, channel: number = 0): Promise<boolean> => {
    const options = {
        body: {
            id: 0,
            method: "Switch.Set",
            params: {
                id: channel,
                on,
            },
        },
    };

    try {
        await postRequest<{}>(
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
        return true;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to set switch on device at ${ip}. Error: ${error.message}`);
    }

    return false;
};

export const shellyReboot = async (ip: string, requestOptions?: ShellyRpcRequestOptions): Promise<any> => {
    const options = {
        body: {
            id: 0,
            method: "Shelly.Reboot",
        },
    };

    const retries = requestOptions?.retries ?? 3;
    const delayMs = requestOptions?.delayMs ?? 1000;
    const timeoutMs = requestOptions?.timeoutMs ?? 7000;
    const connectionHeader = requestOptions?.connectionHeader ?? "keep-alive";

    try {
        const postResponse = await postRequest<{}>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: connectionHeader,
            },
            options.body,
            retries,
            delayMs,
            timeoutMs
        );
        return postResponse;
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to reboot device at ${ip}. Error: ${error.message}`);
    }

    return null;
};

export const shellyCheckForUpdate = async (
    ip: string,
    requestOptions?: ShellyRpcRequestOptions
): Promise<ShellyUpdateCheckResult | null> => {
    const options = {
        body: {
            id: 0,
            method: "Shelly.CheckForUpdate",
        },
    };

    const retries = requestOptions?.retries ?? 3;
    const delayMs = requestOptions?.delayMs ?? 1000;
    const timeoutMs = requestOptions?.timeoutMs ?? 10000;
    const connectionHeader = requestOptions?.connectionHeader ?? "close";

    try {
        const response = await postRequest<ShellyRpcResponse<ShellyUpdateCheckResult>>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: connectionHeader,
            },
            options.body,
            retries,
            delayMs,
            timeoutMs
        );

        if (response.error) {
            logger.info(`[server]: CheckForUpdate RPC error on device at ${ip}. Error: ${response.error.message}`);
            return null;
        }

        return response.result ?? {};
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to check for firmware updates on device at ${ip}. Error: ${error.message}`);
        return null;
    }
};

export const shellyUpdateFirmware = async (
    ip: string,
    stage: "stable" | "beta" = "stable",
    requestOptions?: ShellyRpcRequestOptions
): Promise<{ ok: boolean; message?: string }> => {
    const options = {
        body: {
            id: 0,
            method: "Shelly.Update",
            params: {
                stage,
            },
        },
    };

    const retries = requestOptions?.retries ?? 2;
    const delayMs = requestOptions?.delayMs ?? 1000;
    const timeoutMs = requestOptions?.timeoutMs ?? 12000;
    const connectionHeader = requestOptions?.connectionHeader ?? "close";

    try {
        const response = await postRequest<ShellyRpcResponse<null>>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: connectionHeader,
            },
            options.body,
            retries,
            delayMs,
            timeoutMs
        );

        if (response.error) {
            return { ok: false, message: response.error.message || "Shelly.Update RPC error" };
        }

        return { ok: true };
    } catch (error: Error | any) {
        return { ok: false, message: error.message || "Failed to start firmware update" };
    }
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

export const shellyWebhookList = async (ip: string, requestOptions?: ShellyRpcRequestOptions): Promise<Webhooks | null> => {
    const options = {
        body: {
            id: ip,
            method: "Webhook.List",
        },
    };

    const retries = requestOptions?.retries ?? 3;
    const delayMs = requestOptions?.delayMs ?? 1000;
    const timeoutMs = requestOptions?.timeoutMs ?? 7000;
    const connectionHeader = requestOptions?.connectionHeader ?? "keep-alive";

    try {
        const postResponse = await postRequest<Webhooks>(
            `http://${ip}/rpc/`,
            {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(JSON.stringify(options.body)),
                Accept: "application/json",
                "User-Agent": "ShellyApp/1.0",
                Connection: connectionHeader,
            },
            options.body,
            retries,
            delayMs,
            timeoutMs
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

// Remove any previously-installed trigger webhooks for a group on a device so
// re-assigning a controller doesn't accumulate duplicate or stale hooks.
export const shellyDeleteGroupWebhooks = async (ip: string, groupId: number): Promise<void> => {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "ShellyApp/1.0",
    };
    try {
        const list = await postRequest<{ result?: { hooks?: { id: number; urls?: string[] }[] } }>(
            `http://${ip}/rpc/`,
            headers,
            { id: 0, method: "Webhook.List" }
        );
        const hooks = list?.result?.hooks ?? [];
        const marker = `/api/group/${groupId}/trigger`;
        for (const hook of hooks) {
            if ((hook.urls ?? []).some((url) => url.includes(marker))) {
                await postRequest(`http://${ip}/rpc/`, headers, {
                    id: 0,
                    method: "Webhook.Delete",
                    params: { id: hook.id },
                });
            }
        }
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to clear group webhooks on device at ${ip}. Error: ${error.message}`);
    }
};

// Install a webhook on a physical device so a button press triggers a smart group.
export const shellyActivateGroupWebhook = async (ip: string, groupId: number, mode: "on" | "off", inputId: number = 0): Promise<any> => {
    const options = {
        body: {
            id: 0,
            method: "Webhook.Create",
            params: createGroupWebhookConfig(groupId, mode, inputId),
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
        logger.info(`[server]: Failed to activate group webhook on device at ${ip}. Error: ${error.message}`);
    }

    return null;
}

// Remove any previously-installed companion (3-way) toggle webhooks for a given
// target on a device so re-linking stays idempotent instead of stacking hooks.
export const shellyDeleteCompanionWebhooks = async (ip: string, targetName: string): Promise<void> => {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "ShellyApp/1.0",
    };
    const slug = targetName.replace(/[^a-zA-Z0-9]/g, "-").toLocaleLowerCase();
    try {
        const list = await postRequest<{ result?: { hooks?: { id: number; urls?: string[] }[] } }>(
            `http://${ip}/rpc/`,
            headers,
            { id: 0, method: "Webhook.List" }
        );
        const hooks = list?.result?.hooks ?? [];
        const marker = `/${slug}/switch/message/toggle`;
        for (const hook of hooks) {
            if ((hook.urls ?? []).some((url) => url.includes(marker))) {
                await postRequest(`http://${ip}/rpc/`, headers, {
                    id: 0,
                    method: "Webhook.Delete",
                    params: { id: hook.id },
                });
            }
        }
    } catch (error: Error | any) {
        logger.info(`[server]: Failed to clear companion webhooks on device at ${ip}. Error: ${error.message}`);
    }
};

// Detach a relay device's input so a physical flip stops driving its own relay
// (it becomes a pure companion switch). Best-effort: input-only devices (i4)
// have no Switch component and this simply no-ops.
export const shellyDetachInput = async (
    ip: string,
    switchId: number = 0,
    requestOptions?: ShellyRpcRequestOptions
): Promise<boolean> => {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "ShellyApp/1.0",
        Connection: requestOptions?.connectionHeader ?? "close",
    };
    const retries = requestOptions?.retries ?? 5;
    const delayMs = requestOptions?.delayMs ?? 1200;
    const timeoutMs = requestOptions?.timeoutMs ?? 10000;

    try {
        await postRequest(`http://${ip}/rpc/`, headers, {
            id: 0,
            method: "Switch.SetConfig",
            // initial_state must not be `match_input` when detached (invalid combo).
            params: { id: switchId, config: { in_mode: "detached", initial_state: "restore_last" } },
        }, retries, delayMs, timeoutMs);
        return true;
    } catch (error: Error | any) {
        logger.info(`[server]: Could not detach input on device at ${ip} (may be input-only). Error: ${error.message}`);
        return false;
    }
};

// Install a companion (3-way) toggle webhook: a physical toggle edge on `ip`
// input `inputId` toggles the target device (by name + room) via the server's
// MQTT message endpoint, so it survives target IP (DHCP) changes.
export const shellyActivateCompanionWebhook = async (
    ip: string,
    targetName: string,
    targetRoomId: number,
    mode: "on" | "off",
    inputId: number = 0
): Promise<any> => {
    const options = {
        body: {
            id: 0,
            method: "Webhook.Create",
            params: createCompanionWebhookConfig(targetName, targetRoomId, mode, inputId),
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
        logger.info(`[server]: Failed to activate companion webhook on device at ${ip}. Error: ${error.message}`);
    }

    return null;
}