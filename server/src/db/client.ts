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
            linked boolean NOT NULL DEFAULT false,
            linked_targets text DEFAULT '',
            linked_input_targets text DEFAULT '',
            bundle boolean DEFAULT false
        );
    `;
    // Backfill MQTT columns for databases created before they were added.
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_enable boolean NOT NULL DEFAULT false;`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_server text DEFAULT '';`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_topic text DEFAULT '';`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS linked boolean NOT NULL DEFAULT false;`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS linked_targets text DEFAULT '';`;
    await queryClient`ALTER TABLE devices ADD COLUMN IF NOT EXISTS linked_input_targets text DEFAULT '';`;
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
            cloud_auth_key text DEFAULT '',
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
    // Add cloud_auth_key to pre-existing site_config tables.
    await queryClient`
        ALTER TABLE site_config ADD COLUMN IF NOT EXISTS cloud_auth_key text DEFAULT '';
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
    // One-time migration: seed the cloud auth key from the legacy env var if the
    // DB column is still empty. Lets us drop SHELLY_CLOUD_AUTH_KEY from the env
    // once it lives in the database.
    if (process.env.SHELLY_CLOUD_AUTH_KEY) {
        await queryClient`
            UPDATE site_config
            SET cloud_auth_key = ${process.env.SHELLY_CLOUD_AUTH_KEY}
            WHERE id = 1 AND (cloud_auth_key IS NULL OR cloud_auth_key = '');
        `;
    }
    await queryClient`
        CREATE TABLE IF NOT EXISTS switch_groups (
            id serial PRIMARY KEY,
            name text NOT NULL,
            room_id integer,
            controller_device_id text,
            tie_break text NOT NULL DEFAULT 'on',
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
    await queryClient`
        CREATE TABLE IF NOT EXISTS switch_group_members (
            id serial PRIMARY KEY,
            group_id integer NOT NULL,
            device_id text NOT NULL,
            channel integer NOT NULL DEFAULT 0
        );
    `;
    await queryClient`
        CREATE TABLE IF NOT EXISTS switch_bridges (
            id serial PRIMARY KEY,
            controller_device_id text NOT NULL,
            controller_channel integer NOT NULL DEFAULT 0,
            target_device_id text NOT NULL,
            target_channel integer NOT NULL DEFAULT 0,
            modified timestamp NOT NULL DEFAULT now()
        );
    `;
};
