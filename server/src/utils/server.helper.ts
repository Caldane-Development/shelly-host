import cors from "cors";
import express, { Express } from "express";
import { logger } from "../logger";
import { messageRouter } from "../routers/message.router";
import { shellyRouter } from "../routers/shelly.router";
import { siteRouter } from "../routers/site.router";
import { wifiRouter } from "../routers/wifi.router";
import { mqttBrokerRouter } from "../routers/mqtt-broker.router";
import { siteConfigRouter } from "../routers/site-config.router";
import { groupRouter } from "../routers/group.router";
import { bridgeRouter } from "../routers/bridge.router";

const init = (app: Express) => {
    logger.info(`Add middleware for json parser.`);
    app.use(express.json({ limit: "50mb" }));
    app.use(express.urlencoded({ limit: "50mb", extended: true }));

    logger.info(`Register cors domain: ${process.env.CLIENT_URL}`);
    const corsOptions = {
        origin: [process.env.CLIENT_URL as string],
        optionsSuccessStatus: 204,
        credentials: true
    };
    app.use(cors(corsOptions));

    app.use(`${process.env.VHOST_PREFIX}/message`, messageRouter);
    app.use(`${process.env.VHOST_PREFIX}/shelly`, shellyRouter);
    app.use(`${process.env.VHOST_PREFIX}/site`, siteRouter);
    app.use(`${process.env.VHOST_PREFIX}/wifi`, wifiRouter);
    app.use(`${process.env.VHOST_PREFIX}/mqtt-broker`, mqttBrokerRouter);
    app.use(`${process.env.VHOST_PREFIX}/site-config`, siteConfigRouter);
    app.use(`${process.env.VHOST_PREFIX}/group`, groupRouter);
    app.use(`${process.env.VHOST_PREFIX}/bridge`, bridgeRouter);

};

export { init };
