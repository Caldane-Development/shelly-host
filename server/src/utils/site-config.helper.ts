import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { siteConfig } from "../db/schema";
import { logger } from "../logger";
import site from "../assets/json/site.json";
import config from "../assets/json/config.json";

export interface SiteConfig {
    name: string;
    description: string;
    mqtt: string;
    webhook: string;
    cloudServerUrl: string;
    street: string;
    city: string;
    state: string;
    zip: string;
    cloudAuthKey: string;
}

// Fallback used before the DB cache is hydrated (and if the DB read fails).
const fallback: SiteConfig = {
    name: site.buffington.name ?? "",
    description: site.buffington.description ?? "",
    mqtt: site.buffington.mqtt ?? "",
    webhook: site.buffington.webhook ?? "",
    cloudServerUrl: process.env.SHELLY_CLOUD_SERVER_URL ?? config.discover["cloud-access"].url ?? "",
    street: site.buffington.address?.street ?? "",
    city: site.buffington.address?.city ?? "",
    state: site.buffington.address?.state ?? "",
    zip: site.buffington.address?.zip ?? "",
    cloudAuthKey: process.env.SHELLY_CLOUD_AUTH_KEY ?? "",
};

// In-memory cache so callers that build MQTT topics (createMqttConfig) can read
// the site name/broker synchronously. Hydrated at startup and refreshed on save.
let cache: SiteConfig = { ...fallback };

const rowToConfig = (row: typeof siteConfig.$inferSelect): SiteConfig => ({
    name: row.name ?? "",
    description: row.description ?? "",
    mqtt: row.mqtt ?? "",
    webhook: row.webhook ?? "",
    cloudServerUrl: row.cloudServerUrl ?? "",
    street: row.street ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    zip: row.zip ?? "",
    cloudAuthKey: row.cloudAuthKey ?? "",
});

// Synchronous accessor backed by the in-memory cache.
export const getSiteConfigCached = (): SiteConfig => cache;

// Load the site config from the DB into the cache. Call once at startup.
export const loadSiteConfig = async (): Promise<SiteConfig> => {
    try {
        const [row] = await db.select().from(siteConfig).where(eq(siteConfig.id, 1));
        if (row) {
            cache = rowToConfig(row);
        }
    } catch (error) {
        logger.error(`[site-config]: Failed to load site config, using fallback: ${error}`);
    }
    return cache;
};

export const getSiteConfig = async (): Promise<SiteConfig> => {
    return loadSiteConfig();
};

export const saveSiteConfig = async (update: Partial<SiteConfig>): Promise<SiteConfig> => {
    const merged: SiteConfig = { ...cache, ...update };
    const [row] = await db
        .insert(siteConfig)
        .values({ id: 1, ...merged, modified: new Date() })
        .onConflictDoUpdate({
            target: siteConfig.id,
            set: {
                name: merged.name,
                description: merged.description,
                mqtt: merged.mqtt,
                webhook: merged.webhook,
                cloudServerUrl: merged.cloudServerUrl,
                street: merged.street,
                city: merged.city,
                state: merged.state,
                zip: merged.zip,
                cloudAuthKey: merged.cloudAuthKey,
                modified: new Date(),
            },
        })
        .returning();
    cache = rowToConfig(row);
    return cache;
};
