import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { wifiCredentials } from "../db/schema";

export const getWifiCredentials = async () => {
    return db.select().from(wifiCredentials).orderBy(wifiCredentials.ssid);
};

export const saveWifiCredential = async (ssid: string, password: string) => {
    const [row] = await db
        .insert(wifiCredentials)
        .values({ ssid, password, modified: new Date() })
        .onConflictDoUpdate({
            target: wifiCredentials.ssid,
            set: { password: sql`excluded.password`, modified: new Date() },
        })
        .returning();
    return row;
};

export const deleteWifiCredential = async (id: number): Promise<void> => {
    await db.delete(wifiCredentials).where(eq(wifiCredentials.id, id));
};
