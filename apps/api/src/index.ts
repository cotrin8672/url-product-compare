import {
  createApiHandler,
  createPublicConsumerApi,
} from "../../../packages/backend/src/bootstrap.js";

const allowedOrigin = process.env["API_ALLOWED_ORIGIN"] ?? process.env["RENDER_EXTERNAL_URL"];
const jevApiKey = process.env["JEV_API_KEY"] ?? process.env["TYPESAFE_API_KEY"];

const internal = createApiHandler(
  false,
  [
    "RAKUTEN_APPLICATION_ID",
    "RAKUTEN_ACCESS_KEY",
    "RAKUTEN_AFFILIATE_ID",
    "RAKUTEN_ALLOWED_ORIGIN",
    "RAKUTEN_DATA_AUTHORIZED_UNTIL",
  ].some((name) => process.env[name] !== undefined)
    ? {
        applicationId: process.env["RAKUTEN_APPLICATION_ID"],
        accessKey: process.env["RAKUTEN_ACCESS_KEY"],
        affiliateId: process.env["RAKUTEN_AFFILIATE_ID"],
        allowedOrigin: process.env["RAKUTEN_ALLOWED_ORIGIN"] ?? process.env["RENDER_EXTERNAL_URL"],
        authorizedUntil: process.env["RAKUTEN_DATA_AUTHORIZED_UNTIL"],
        ...(process.env["RAKUTEN_RESULT_STORAGE_AUTHORIZED_UNTIL"] === undefined
          ? {}
          : {
              resultStorageAuthorizedUntil: process.env["RAKUTEN_RESULT_STORAGE_AUTHORIZED_UNTIL"],
            }),
        accessToken: process.env["API_ACCESS_TOKEN"],
      }
    : null,
  process.env["OPENAI_API_KEY"] === undefined || process.env["OPENAI_API_KEY"].trim() === ""
    ? null
    : { apiKey: process.env["OPENAI_API_KEY"], model: process.env["OPENAI_MODEL"] ?? "gpt-6-luna" },
  jevApiKey === undefined || jevApiKey.trim() === ""
    ? null
    : { apiKey: jevApiKey, model: process.env["JEV_MODEL"] ?? "jev-1.13.0" },
  {
    ...(process.env["API_ACCESS_TOKEN"] === undefined
      ? {}
      : { apiAccessToken: process.env["API_ACCESS_TOKEN"] }),
    ...(allowedOrigin === undefined ? {} : { allowedOrigin }),
  },
);
export const handler = createPublicConsumerApi(internal, {
  accessToken: process.env["API_ACCESS_TOKEN"] ?? null,
  allowedOrigin: allowedOrigin ?? "http://127.0.0.1:5173",
});
