import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { mqttBrokers, devices } from "../db/schema";

const normalizeBrokerServer = (server: string): string =>
    server.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").trim().toLocaleLowerCase();

export const getMqttBrokers = async () => {
    return db.select().from(mqttBrokers).orderBy(mqttBrokers.server);
};

export const getMqttBrokerByServer = async (server: string) => {
    const brokers = await getMqttBrokers();
    const normalized = normalizeBrokerServer(server);
    return brokers.find((broker) => normalizeBrokerServer(broker.server) === normalized) ?? null;
};

// Distinct MQTT broker addresses discovered on devices (from their persisted
// mqtt_server), so the UI can suggest brokers that are already in use.
export const getAvailableBrokers = async (): Promise<string[]> => {
    const rows = await db
        .selectDistinct({ server: devices.mqttServer })
        .from(devices)
        .where(sql`${devices.mqttServer} <> ''`)
        .orderBy(devices.mqttServer);
    return rows.map((row) => row.server).filter((server): server is string => Boolean(server));
};

export const saveMqttBroker = async (server: string, username: string, password: string) => {
    const [row] = await db
        .insert(mqttBrokers)
        .values({ server, username, password, modified: new Date() })
        .onConflictDoUpdate({
            target: mqttBrokers.server,
            set: {
                username: sql`excluded.username`,
                password: sql`excluded.password`,
                modified: new Date(),
            },
        })
        .returning();
    return row;
};

export const deleteMqttBroker = async (id: number): Promise<void> => {
    await db.delete(mqttBrokers).where(eq(mqttBrokers.id, id));
};
