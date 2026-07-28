import { MqttResult as MqttResponseResult } from "./mqtt.interface";
import { ShellySwitch } from "./shelly.interface";
import { Webhooks } from "./webhooks.interface";

export interface IDevice {
    ip: string;
    name: string;
    type: string;
    channel: string;
    mqtt: MqttResponseResult;
    linked?: boolean;
    linkedTargets?: string[];
    linkedInputTargets?: Record<string, string[]>;
    inputStates?: boolean[];
    room?: { name: string, id: number };
    webhooks?: Webhooks;
    switchStatus: ShellySwitch;
    device: Device;
    src?: string;
    verificationWarning?: string;
}

export interface DeviceList {
    isok: boolean
    data: Data
  }
  
  export interface Data {
    devices: Devices
  }
  
  export interface Devices {
    [key: string]: Device
  }
  
  export interface Device {
    id: string | number
    type: string
    category: string
    position: number
    gen: number
    channel: number
    channels_count: number
    mode: string
    name: string
    room_id: number
    image: string
    cloud_options: CloudOptions
    cloud_online?: boolean
    modified: number
    ip: string
    ssid: string
  }
  
  export interface CloudOptions {
    exclude_event_log: boolean
  }
  
