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
const axiosRetry = require('axios-retry');
const { Datastore } = require('@google-cloud/datastore');
const https = require('https');
const ping = require('ping');
const datastore = new Datastore();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const net = require('net');
const nodemailer = require("nodemailer");

axiosRetry(axios, {
    retries: 2,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error)
            || error.code === 'ECONNABORTED';
    },
    retryDelay: (retryCount) => {
        logger.warn(`retry attempt: ${retryCount}`);
        return retryCount * 1000;
    },
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
});

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

    let source = axios.CancelToken.source();
    setTimeout(() => {
        source.cancel();
    }, 12000);

    try {
        await axios.get(`${service.endpoint}:${service.port}`, { cancelToken: source.token, httpsAgent, maxRedirects: 0, timeout: 3000 });
    } catch (error) {
        if ((error.response && error.response.status > 500) || !error.response) {
            logger.error(`axios get error for ${service.endpoint}:${service.port}, ${error.code || error}`);
            service.failed = true;
        }
    }
}

async function pingEndpoint(service) {
    service.failed = false;

    logger.info(`pingEndpoint: ${service.endpoint}`);
    try {
        const pingResult = await ping.promise.probe(service.endpoint,
            { deadline: 12, min_reply: 3, timeout: 5, });
        if (!pingResult.alive) {
            service.failed = true;
        }
    } catch (error) {
        logger.error(error);
        service.failed = true;
    }
}

async function socketEndpoint(service) {
    service.failed = false;
    const attempts = 3;

    logger.info(`socketEndpoint: ${service.endpoint}:${service.port}`);
    for (let i = 0; i < attempts; i++ ) {
        try {
            await new Promise((resolve, reject) => {   
                const socket = new net.Socket();
                socket.setTimeout(3000);
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
            break;
        } catch (error) {
            logger.error(error);
            service.failed = true;
        }
        await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
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
