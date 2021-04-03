'use strict';

require('dotenv').config();
const https = require('https');
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
const ping = require('ping');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY || 'SENDGRID-API-KEY');

const SERVER_PING_ENDPOINT = process.env.SERVER_PING_ENDPOINT;
const PLEX_SERVER_ENDPOINT = process.env.PLEX_SERVER_ENDPOINT;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

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

async function pingEndpoint(endpoint) {
	const result = { endpoint, failed: false };

    logger.info(`pingEndpoint: ${endpoint}`);
    try {
        if (!(await ping.promise.probe(endpoint)).alive) {
            result.failed = true;
        }
    } catch (error) {
		logger.error(error);
        result.failed = true;
    }

    return result;
}

async function getEndpoint(endpoint) {
	const result = { endpoint, failed: false };

	logger.info(`getEndpoint: ${endpoint}`);
	try {
		await axios.get(endpoint, { httpsAgent, maxRedirects:0 });
	} catch (error) {
        if ((error.response && error.response.status > 500) || !error.response) {
            logger.error(error);
            result.failed = true;
        }
	}

	return result;
}

async function sendAlertEmail(alertEndpoints) {
    console.log(alertEndpoints);
}

/**
 * Gets metrics if pinged by http request.
 *
 * @param {!express:Request} req HTTP request context.
 * @param {!express:Response} res HTTP response context.
 */
exports.checkServices = async(req, res) => {
	const alertEndpoints = [];

	const results = await Promise.all([
        pingEndpoint(SERVER_PING_ENDPOINT),
		getEndpoint(PLEX_SERVER_ENDPOINT),
	]);

	for (const result of results) {
		if (result.failed) {
			alertEndpoints.push(result.endpoint);
		}
	}

	await sendAlertEmail(alertEndpoints);

	res.status(200).send();
};