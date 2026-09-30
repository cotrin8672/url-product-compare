import { createApiHandler } from "../../../packages/backend/src/bootstrap.js";

const lambda = process.env["AWS_LAMBDA_FUNCTION_NAME"] !== undefined;
const resourceArn = process.env["DB_RESOURCE_ARN"];
const secretArn = process.env["DB_SECRET_ARN"];
const database = process.env["DB_NAME"];
const configured =
  lambda || resourceArn !== undefined || secretArn !== undefined || database !== undefined;
if (
  configured &&
  (resourceArn === undefined ||
    !/^arn:aws(?:-cn|-us-gov)?:rds:[a-z0-9-]+:\d{12}:cluster:[a-zA-Z0-9-]+$/.test(resourceArn) ||
    secretArn === undefined ||
    !/^arn:aws(?:-cn|-us-gov)?:secretsmanager:[a-z0-9-]+:\d{12}:secret:[a-zA-Z0-9/_+=.@-]+$/.test(
      secretArn,
    ) ||
    database === undefined ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database))
) {
  throw new Error("Valid DB_RESOURCE_ARN, DB_SECRET_ARN and DB_NAME are required together");
}
export const handler = createApiHandler(
  resourceArn !== undefined && secretArn !== undefined && database !== undefined
    ? { resourceArn, secretArn, database }
    : null,
  [
    "RAKUTEN_APPLICATION_ID",
    "RAKUTEN_ACCESS_KEY",
    "RAKUTEN_ALLOWED_ORIGIN",
    "RAKUTEN_DATA_AUTHORIZED_UNTIL",
    "API_ACCESS_TOKEN",
  ].some((name) => process.env[name] !== undefined)
    ? {
        applicationId: process.env["RAKUTEN_APPLICATION_ID"],
        accessKey: process.env["RAKUTEN_ACCESS_KEY"],
        allowedOrigin: process.env["RAKUTEN_ALLOWED_ORIGIN"],
        authorizedUntil: process.env["RAKUTEN_DATA_AUTHORIZED_UNTIL"],
        accessToken: process.env["API_ACCESS_TOKEN"],
      }
    : null,
);
