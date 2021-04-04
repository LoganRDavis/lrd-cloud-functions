# Service Checker

This is a simple cloud function that pings/httpGets/sockets an endpoint to check if a service is available. The job can be triggered via a cron job service such as gcloud cloud scheduler. All requests are built with retry logic to avoid false positives. Sending emails does require an smtp server. 

## Service Schema

| field           | type          | Purpose | Example                              |
|-----------------|---------------|---------|--------------------------------------|
| action          | String        |         | GET                                  |
| alertCount      | int           |         | 3                                    |
| enabled         | boolean       |         | true                                 |
| endpoint        | String        |         | https://www.example.com              |
| id              | String (uuid) |         | f660c41e-0a34-49ab-9134-586465f3958c |
| lastAlertDate   | Date          |         | 2021-04-01 (20:07:34.447) CST        |
| lastSuccessDate | Date          |         | 2021-04-03 (21:06:28.596) CST        |
| name            | String        |         | www.example.com Get                  |
| port            | int           |         | 443                                  |
| triggered       | boolean       |         | false                                |

## Running Locally

- `gcloud auth application-default login`
- `npm start`
- Backup option: `npx @google-cloud/functions-framework --target=checkServices`

## Deploying

- Ensure correct project: `gcloud config list`
- `gcloud functions deploy service-checker --entry-point checkServices`
