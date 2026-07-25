import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

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
            bundle boolean DEFAULT false
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
};
