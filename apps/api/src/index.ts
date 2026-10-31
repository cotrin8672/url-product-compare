import {
  createApiHandler,
  createPublicConsumerApi,
} from "../../../packages/backend/src/bootstrap.js";

const allowedOrigin = process.env["API_ALLOWED_ORIGIN"] ?? process.env["RENDER_EXTERNAL_URL"];
const jevApiKey = process.env["JEV_API_KEY"] ?? process.env["TYPESAFE_API_KEY"];
function commerceConfiguration(): unknown {
  const raw = process.env["COMMERCE_CONFIGURATION"];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    throw new Error("COMMERCE_CONFIGURATION must be valid JSON");
  }
}

function securitiesAffiliateConfiguration(): unknown {
  const raw = process.env["SECURITIES_AFFILIATES"];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    throw new Error("SECURITIES_AFFILIATES must be valid JSON");
  }
}

const internal = createApiHandler(
  false,
  [
    "RAKUTEN_APPLICATION_ID",
    "RAKUTEN_ACCESS_KEY",
    "RAKUTEN_AFFILIATE_ID",
    "RAKUTEN_ALLOWED_ORIGIN",
  ].some((name) => process.env[name] !== undefined)
    ? {
        applicationId: process.env["RAKUTEN_APPLICATION_ID"],
        accessKey: process.env["RAKUTEN_ACCESS_KEY"],
        affiliateId: process.env["RAKUTEN_AFFILIATE_ID"],
        allowedOrigin: process.env["RAKUTEN_ALLOWED_ORIGIN"] ?? process.env["RENDER_EXTERNAL_URL"],
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
    commerceConfiguration: commerceConfiguration(),
    securitiesAffiliateConfiguration: securitiesAffiliateConfiguration(),
    ...(process.env["API_ACCESS_TOKEN"] === undefined
      ? {}
      : { apiAccessToken: process.env["API_ACCESS_TOKEN"] }),
    ...(allowedOrigin === undefined ? {} : { allowedOrigin }),
  },
);
export const handler = createPublicConsumerApi(internal, {
  accessToken: process.env["API_ACCESS_TOKEN"] ?? null,
  allowedOrigin: allowedOrigin ?? "http://127.0.0.1:5173",
  ...(allowedOrigin === undefined
    ? {
        allowedOrigins: ["http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175"],
      }
    : {}),
});
