import winston, { format, transports } from "winston";
import LokiTransport from "winston-loki";

// Custom log levels. Lower number = higher priority (always shown at stricter modes).
// error/warn are always surfaced; `state` = device state changes; `request` = HTTP
// requests and outgoing commands; `info`/`debug` are verbose-only chatter.
const levels = {
  error: 0,
  warn: 1,
  state: 2,
  request: 3,
  info: 4,
  debug: 5,
};

// LOG_MODE maps a friendly name to the winston level threshold applied to the console.
//   state   -> only state changes (plus errors/warnings)
//   normal  -> state changes and requests
//   verbose -> everything
const LOG_MODES: Record<string, keyof typeof levels> = {
  state: "state",
  normal: "request",
  verbose: "debug",
};

const mode = (process.env.LOG_MODE || "normal").toLowerCase();
const consoleLevel = LOG_MODES[mode] || "request";

type CustomLogger = winston.Logger & {
  state: winston.LeveledLogMethod;
  request: winston.LeveledLogMethod;
};

export const logger = winston.createLogger({
  levels,
  level: consoleLevel,
  transports: [
    new transports.Console({ level: consoleLevel }),
    new transports.File({
      level: 'info',
      filename: 'logs/info.log'
    }),
    new transports.File({
      level: 'warn',
      filename: 'logs/warn.log'
    }),
    new transports.File({
      level: 'error',
      filename: 'logs/error.log'
    }),
    new LokiTransport({
      host: process.env.LOKI_URL || 'http://localhost:3100',
      labels: { app: 'shelly-host' },
      json: true,
    })
  ],
  format: format.combine(
    format.json(),
    format.timestamp(),
    format.metadata(),
    format.prettyPrint()
  )
}) as CustomLogger;

logger.info(`[server]: Logging mode '${mode}' (console level: ${consoleLevel})`);


export const logEnv = () => {
  const environment = [
    "PORT",
    "MQTT_URL",
    "CLIENT_URL",
    "SHELLY_CLOUD_AUTH_KEY",
    "VHOST_PREFIX"
  ].reduce((acc, key) => {
    acc[key.substring(0, 20).padStart(20, " ")] = process.env[key]?.substring(0, 60).padEnd(60, " ");
    return acc;
  }, {} as { [key: string]: string | undefined });
  environment["NODE_VERSION".padStart(20, " ")] = process.versions.node.padEnd(60, " ");
  logger.info("Environment: ");
  console.table(environment);
}