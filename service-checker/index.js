'use strict';

require('dotenv').config();
const logger = require('pino')({
    formatters: {
        level,
    },
    base: null,
    messageKey: 'message',
    timestamp: true,
    level: process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toLowerCase() : 'info',
});
const axios = require('axios');
const { Datastore } = require('@google-cloud/datastore');
const https = require('https');
const ping = require('ping');
const datastore = new Datastore();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const net = require('net');
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
});

const RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = 2000;
const TIMEOUT_MS = 5000;

// Map pino levels to GCP, https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
function severity(label) {
    switch (label) {
        case 'trace': return 'DEBUG';
        case 'debug': return 'DEBUG';
        case 'info': return 'INFO';
        case 'warn': return 'WARNING';
        case 'error': return 'ERROR';
        case 'fatal': return 'CRITICAL';
        default: return 'DEFAULT';
    }
}

function level(label, number) {
    return { severity: severity(label) };
}

async function getServices() {
    const [services] = await datastore.createQuery('ServiceCheckerService').run()
    return services;
}

async function updateServices(services) {
    const entities = [];
    for (const service of services) {
        delete service.failed;
        entities.push({
            key: datastore.key(['ServiceCheckerService', service.id]),
            data: service,
        });
    }
    await datastore.save(entities);
}

async function getEndpoint(service) {
    service.failed = false;

    logger.info(`getEndpoint: ${service.endpoint}:${service.port}`);

    for (let i = 1; i <= RETRY_COUNT; i++ ) {
        const source = axios.CancelToken.source();
        setTimeout(() => {
            source.cancel();
        }, TIMEOUT_MS);

        try {
            await axios.get(`${service.endpoint}:${service.port}`, { cancelToken: source.token, httpsAgent, maxRedirects: 0, timeout: 3000 });
            service.failed = false;
        } catch (error) {
            if (error.response && error.response.status < 500) {
                service.failed = false;
            } else {
                logger.error(`axios get error for ${service.endpoint}:${service.port}, ${error.code || error}`);
                service.failed = true;
            }
        }
        if (!service.failed) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, i * RETRY_BACKOFF_MS));
    }
}

async function pingEndpoint(service) {
    service.failed = false;

    logger.info(`pingEndpoint: ${service.endpoint}`);
    for (let i = 1; i <= RETRY_COUNT; i++ ) {
        try {
            const pingResult = await ping.promise.probe(service.endpoint, { 
                deadline: TIMEOUT_MS / 1000,
                min_reply: RETRY_COUNT,
                timeout: TIMEOUT_MS / 1000,
            });
            service.failed = !pingResult.alive;
        } catch (error) {
            logger.error(error);
            service.failed = true;
        }
        if (!service.failed) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, i * RETRY_BACKOFF_MS));
    }
}

async function socketEndpoint(service) {
    service.failed = false;

    logger.info(`socketEndpoint: ${service.endpoint}:${service.port}`);
    for (let i = 1; i <= RETRY_COUNT; i++ ) {
        try {
            await new Promise((resolve, reject) => {   
                const socket = new net.Socket();
                socket.setTimeout(TIMEOUT_MS);
                socket.on('connect', () => {
                    socket.destroy();
                    resolve();
                });   
                socket.on('timeout', () => {
                    socket.end();
                    reject('timeout');
                });
                socket.on('error', (error) => {
                    socket.destroy();
                    reject(error);
                });   
                socket.connect({  host: service.endpoint, port: service.port });
            }); 

            service.failed = false;
        } catch (error) {
            logger.error(error);
            service.failed = true;
        }
        if (!service.failed) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, i * RETRY_BACKOFF_MS));
    }
}

async function sendEmails(services) {
    const failedServices = [];
    const recoveredServices = [];
    for (const service of services) {
        if (!service.enabled) {
            continue;
        } else if (service.failed && !service.triggered) {
            service.lastAlertDate = new Date();
            service.triggered = true;
            service.alertCount += 1;
            failedServices.push(service.name);
        } else if (!service.failed) {
            service.lastSuccessDate = new Date();
            if (service.triggered) {
                recoveredServices.push(service.name);
                service.triggered = false;
            }
        }
    }

    await Promise.all([
        sendAlertEmail(failedServices),
        sendRecoverEmail(recoveredServices),
    ]);
}

async function sendAlertEmail(serviceNames) {
    if (!serviceNames.length) {
        return;
    }

    try {
        const emailMessage = `Your service(s), ${serviceNames.join(', ')}, are not currently available. Please check for issues.`;
        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: process.env.EMAIL_TO,
            subject: 'Service Checker Alert',
            text: emailMessage,
            html: emailMessage,
        });
    } catch (error) {
        logger.error(error);
    }
}

async function sendRecoverEmail(serviceNames) {
    if (!serviceNames.length) {
        return;
    }

    try {
        const emailMessage = `Your service(s), ${serviceNames.join(', ')}, have recovered. :)`;
        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: process.env.EMAIL_TO,
            subject: 'Service Checker Alert',
            text: emailMessage,
            html: emailMessage,
        });
    } catch (error) {
        logger.error(error);
    }
}

/**
 * Sends alerts on service status changes
 *
 * @param {!express:Request} req HTTP request context.
 * @param {!express:Response} res HTTP response context.
 */
exports.checkServices = async (req, res) => {
    const services = await getServices();
    const checkEndpointPromises = [];

    for (const service of services) {
        if (!service.enabled) {
            continue;
        }
        switch (service.action) {
            case 'GET':
                checkEndpointPromises.push(getEndpoint(service))
                break;
            case 'PING':
                checkEndpointPromises.push(pingEndpoint(service))
                break;
            case 'SOCKET':
                checkEndpointPromises.push(socketEndpoint(service))
                break;
            default:
                service.enabled = false;
                break;
        }
    }

    await Promise.all(checkEndpointPromises);
    await sendEmails(services);
    await updateServices(services)

    res.status(200).send();
};
