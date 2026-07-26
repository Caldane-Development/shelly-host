import { logger } from "../logger";
import sites from "../assets/json/site.json"
import { Room, Site } from "../../../common/models/sites.interface";
import { mqtt } from "./mqtt.helper";

export const channelDictionary = {
  "downstairs": "shellyplus1-bighouse/command/switch:0",
  "stairs": "buffington-stairs/command/switch:0",
  "masterCloset": "buffington-masterCloset/command/switch:0",
  "kitchen": "buffington-kitchen/command/switch:0",
  "livingroom": "buffington-livingroom/command/switch:0",
  "diningroom": "buffington-diningroom/command/switch:0",
  "jackAndJill": "buffington-jackAndJill/command/switch:0",
  "masterBedroom": "buffington-masterBedroom/command/switch:0",
  "masterBathroom": "buffington-masterBathroom/command/switch:0",
  "laundryRoom": "buffington-laundryRoom/command/switch:0",
  "garage": "buffington-garage/command/switch:0",
  "outside": "buffington-outside/command/switch:0",
  "butlersPantry": "buffington-butlersPantry/command/switch:0",
  "mudroom": "buffington-mudroom/command/switch:0",
  "studio": "buffington-studio/command/switch:0",
} as const;

const getRoom = (siteName: string, roomName: string) => {
  if (siteName as keyof typeof sites === undefined) {
    logger.info(`[server]: Site [${siteName}] not configured`);
    throw new Error(`Site [${siteName}] not configured`);
  }

  const site: Site = sites[siteName as keyof typeof sites];
  if (!site) {
    throw new Error(`Site [${siteName}] not found`)
  }

  const room: Room = site.rooms[roomName as keyof typeof site.rooms];
  if (!room) {
    throw new Error(`Room [${roomName}] not found in site [${site.name}]`);
  }

  return { site, room };

}

export const sendMessageToRoom = (siteName: string, roomName: string, clientName: any, message: string) => {
  sendMessageToDevices(siteName, roomName, undefined, clientName, message);
}

export const sendMessageToDevices = (siteName: string, roomName: string, deviceNames: string[] | undefined, clientName: any, message: string) => {
  const { site, room } = getRoom(siteName.toLocaleLowerCase(), roomName.toLocaleLowerCase());
  let devices = room.switches;
  if (deviceNames !== undefined) {
    if (Array.isArray(deviceNames)) {
      devices = room?.switches?.filter((device) => deviceNames.some((name) => device.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0));
      if (!devices || devices.length === 0) {
        throw new Error(`Devices [${deviceNames.join(", ")}] not found in room [${room.name}]`);
      }
    } 
  }

  devices?.forEach((device) => {
    const mqttChannel = `${site.name}/${room.name}/${device.name}/command/switch:${device.channel}`;
    logger.request(`[server]: Publish mqtt message: ${mqttChannel} \n    ${message}`);
    mqtt.publish(clientName, mqttChannel, message);
  });
}