import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import site from "../assets/json/site.json";

const connectionString = process.env.DATABASE_URL as string;

const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });

// Ensure required tables exist (drizzle-kit 0.18.1 has no pg push command)
export const ensureSchema = async (): Promise<void> => {
    await queryClient`
        CREATE TABLE IF NOT EXISTS devices (
            id text PRIMARY KEY,
            type text NOT NULL,
            category text NOT NULL,
            position integer NOT NULL,
            gen integer NOT NULL,
            channel integer NOT NULL,
            channels_count integer NOT NULL,
            mode text NOT NULL,
            name text NOT NULL,
            room_id integer NOT NULL,
            image text NOT NULL,
            cloud_options jsonb NOT NULL,
            jti text DEFAULT '',
            cloud_online boolean NOT NULL,
            modified timestamp NOT NULL,
            ip varchar(45) NOT NULL,
            ssid text NOT NULL,
            mqtt_enable boolean NOT NULL DEFAULT false,
            mqtt_server text DEFAULT '',
            mqtt_topic text DEFAULT '',
            bundle boolean DEFAULT false
        );
    `;
    // Backfill MQTT columns for databases created before they were added.
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_enable boolean NOT NULL DEFAULT false;`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_server text DEFAULT '';`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_topic text DEFAULT '';`;
    await queryClient`
        CREATE TABLE IF NOT EXISTS rooms (
            id integer PRIMARY KEY,
            name text NOT NULL,
            image text NOT NULL DEFAULT '',
            background_color text DEFAULT '',
            main_sensor boolean NOT NULL DEFAULT false,
            overview_style boolean NOT NULL DEFAULT false,
            position integer NOT NULL DEFAULT 0,
            modified timestamp NOT NULL
        );
    `;
    await queryClient`
        CREATE TABLE IF NOT EXISTS wifi_credentials (
            id serial PRIMARY KEY,
            ssid text NOT NULL UNIQUE,
            password text NOT NULL,
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
    await queryClient`
        CREATE TABLE IF NOT EXISTS mqtt_brokers (
            id serial PRIMARY KEY,
            server text NOT NULL UNIQUE,
            username text DEFAULT '',
            password text DEFAULT '',
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
    await queryClient`
        CREATE TABLE IF NOT EXISTS site_config (
            id integer PRIMARY KEY,
            name text NOT NULL DEFAULT '',
            description text DEFAULT '',
            mqtt text DEFAULT '',
            webhook text DEFAULT '',
            street text DEFAULT '',
            city text DEFAULT '',
            state text DEFAULT '',
            zip text DEFAULT '',
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
    // Seed the single site_config row (id=1) from site.json on first run only.
    const buffington = site.buffington;
    await queryClient`
        INSERT INTO site_config (id, name, description, mqtt, webhook, street, city, state, zip, modified)
        VALUES (
            1,
            ${buffington.name ?? ""},
            ${buffington.description ?? ""},
            ${buffington.mqtt ?? ""},
            ${buffington.webhook ?? ""},
            ${buffington.address?.street ?? ""},
            ${buffington.address?.city ?? ""},
            ${buffington.address?.state ?? ""},
            ${buffington.address?.zip ?? ""},
            now()
        )
        ON CONFLICT (id) DO NOTHING;
    `;
};
