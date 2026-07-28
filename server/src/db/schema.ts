// src/db/schema.ts
import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  jsonb, varchar, bigint, serial
} from 'drizzle-orm/pg-core';

export const rooms = pgTable('rooms', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  image: text('image').notNull(),
  backgroundColor: text('background_color').default(''),
  mainSensor: boolean('main_sensor').notNull(),
  overviewStyle: boolean('overview_style').notNull(),
  position: integer('position').notNull(),
  modified: timestamp('modified', { mode: 'date' }).notNull(),
});


export const devices = pgTable('devices', {
  id: text('id').primaryKey(),        // string IDs like "543204665bac"
  type: text('type').notNull(),
  category: text('category').notNull(),
  position: integer('position').notNull(),
  gen: integer('gen').notNull(),
  channel: integer('channel').notNull(),
  channelsCount: integer('channels_count').notNull(),
  mode: text('mode').notNull(),
  name: text('name').notNull(),
  roomId: integer('room_id').notNull(),
  image: text('image').notNull(),
  cloudOptions: jsonb('cloud_options').notNull(),  // stores { exclude_event_log: boolean }
  jti: text('jti').default(''),          // optional string, default empty
  cloudOnline: boolean('cloud_online').notNull(),
  modified: timestamp('modified', { mode: 'date' }).notNull(),
  ip: varchar('ip', { length: 45 }).notNull(),  // IPv4/IPv6 max length 45 chars
  ssid: text('ssid').notNull(),
  mqttEnable: boolean('mqtt_enable').notNull().default(false),
  mqttServer: text('mqtt_server').default(''),
  mqttTopic: text('mqtt_topic').default(''),
  linked: boolean('linked').notNull().default(false),
  linkedTargets: text('linked_targets').default(''),
  bundle: boolean('bundle').default(false),  // optional field, default false
});

export const wifiCredentials = pgTable('wifi_credentials', {
  id: serial('id').primaryKey(),
  ssid: text('ssid').notNull().unique(),
  password: text('password').notNull(),
  modified: timestamp('modified', { mode: 'date' }).notNull().defaultNow(),
});

export const mqttBrokers = pgTable('mqtt_brokers', {
  id: serial('id').primaryKey(),
  server: text('server').notNull().unique(),
  username: text('username').default(''),
  password: text('password').default(''),
  modified: timestamp('modified', { mode: 'date' }).notNull().defaultNow(),
});

export const siteConfig = pgTable('site_config', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().default(''),
  description: text('description').default(''),
  mqtt: text('mqtt').default(''),
  webhook: text('webhook').default(''),
  street: text('street').default(''),
  city: text('city').default(''),
  state: text('state').default(''),
  zip: text('zip').default(''),
  cloudAuthKey: text('cloud_auth_key').default(''),
  modified: timestamp('modified', { mode: 'date' }).notNull().defaultNow(),
});

// A logical switch that controls multiple devices with "smart" majority logic:
// when triggered, all members are set to the opposite of the majority state.
export const switchGroups = pgTable('switch_groups', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  roomId: integer('room_id'),                       // optional room this group seeds from
  controllerDeviceId: text('controller_device_id'), // optional physical device that triggers it
  tieBreak: text('tie_break').notNull().default('on'), // 'on' | 'off' when members split evenly
  modified: timestamp('modified', { mode: 'date' }).notNull().defaultNow(),
});

export const switchGroupMembers = pgTable('switch_group_members', {
  id: serial('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  deviceId: text('device_id').notNull(),
  channel: integer('channel').notNull().default(0),
});

// A one-way controller -> target link driven over MQTT. When the controller
// device publishes a switch state change (NotifyStatus), the server sets the
// target device to the same state. Replaces the old outgoing-webhook approach
// and needs no static IPs (commands go to the target's MQTT topic).
export const switchBridges = pgTable('switch_bridges', {
  id: serial('id').primaryKey(),
  controllerDeviceId: text('controller_device_id').notNull(),
  controllerChannel: integer('controller_channel').notNull().default(0),
  targetDeviceId: text('target_device_id').notNull(),
  targetChannel: integer('target_channel').notNull().default(0),
  modified: timestamp('modified', { mode: 'date' }).notNull().defaultNow(),
});
