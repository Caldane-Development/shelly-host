import "dotenv/config";
import express, { Express, Request, Response } from "express";

import expressWinston from "express-winston";
import { logEnv, logger } from "./logger";

import { init } from "./utils/server.helper";
import { ensureSchema } from "./db/client";
import { loadSiteConfig } from "./utils/site-config.helper";
import { loadBridges } from "./utils/bridge.helper";



logger.info(`[server]: Environment: ${process.env.NODE_ENV}`, { PORT: process.env.PORT, MQTT_URL: process.env.MQTT_URL });

ensureSchema()
    .then(() => logger.info("[server]: Database schema ensured"))
    .then(() => loadSiteConfig())
    .then((config) => logger.info(`[server]: Site config loaded (site: ${config.name})`))
    .then(() => loadBridges())
    .catch((error) => logger.error(`[server]: Failed to ensure database schema: ${error}`));

const app: Express = express();
const port = process.env.PORT || 3000;

app.use(
    expressWinston.logger({
        winstonInstance: logger,
        statusLevels: false,
        level: (req, res) => {
            if (res.statusCode >= 500) return "error";
            if (res.statusCode >= 400) return "warn";
            // Health checks fire constantly; only surface them in verbose mode.
            if (req.url === "/health") return "debug";
            return "request";
        },
    })
);

init(app);

app.get("/", (_: Request, res: Response) => {
    logEnv();
    res.send("<h1>MQTT Server</h1><p>Use /channel/:channel/message/:message/:clientName to send a message to a channel</p>");
});

app.get("/health", (_: Request, res: Response) => {
    res.status(200).send("Healthy");
});

app.listen(port, () => {
    logger.info(`[server]: Web Server is running at http://localhost:${port}`);
});
