import { createHmac } from "node:crypto";

import {
  createApiHandler,
  createPersistedComparisonJobRunner,
  createPublicConsumerApi,
  configuredHttpDependencies,
  systemTime,
} from "./bootstrap.js";
import { err, ok } from "./comparison/algebra.js";
import { record } from "./comparison/values.js";
import { createLambdaHttpHandler } from "./infrastructure/aws/http.js";
import { createLambdaDispatcher } from "./infrastructure/aws/invoke.js";
import { createDynamoCategoryCache } from "./infrastructure/dynamodb/categories.js";
import { createDynamoDatabase } from "./infrastructure/dynamodb/database.js";
import type { DynamoDatabase } from "./infrastructure/dynamodb/database.js";
import { createDynamoComparisonJobStore } from "./infrastructure/dynamodb/jobs.js";
import { createDynamoRateLimiter } from "./infrastructure/dynamodb/limits.js";
import type { ApiResponse } from "./infrastructure/http/request.js";

function configurationObject(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!record(input) || Object.keys(input).some((key) => !fields.includes(key))) {
    throw new Error("Invalid Lambda configuration fields");
  }
  return input;
}

export function combineLambdaConfiguration(
  secretInput: unknown,
  applicationInput: unknown,
): Readonly<Record<string, unknown>> {
  const secrets = configurationObject(secretInput, [
    "http",
    "rakuten",
    "openai",
    "jev",
    "commerce",
    "accesstrade",
  ]);
  const settings = configurationObject(applicationInput, [
    "http",
    "rakuten",
    "openai",
    "jev",
    "commerce",
    "securitiesAffiliates",
  ]);
  const section = (
    secret: unknown,
    configuration: unknown,
    secretFields: readonly string[],
    settingFields: readonly string[],
  ): Readonly<Record<string, unknown>> | null => {
    const publicValues =
      configuration === undefined || configuration === null
        ? {}
        : configurationObject(configuration, settingFields);
    if (secret === undefined || secret === null) {
      return null;
    }
    return { ...publicValues, ...configurationObject(secret, secretFields) };
  };
  const commerceSecrets =
    secrets["commerce"] === undefined || secrets["commerce"] === null
      ? {}
      : configurationObject(secrets["commerce"], ["satofull", "yahoo", "amazon"]);
  const commerceSettings =
    settings["commerce"] === undefined || settings["commerce"] === null
      ? {}
      : configurationObject(settings["commerce"], ["satofull", "yahoo", "amazon"]);
  return {
    http: section(
      secrets["http"],
      settings["http"],
      ["accessToken"],
      ["allowedOrigin", "globalPerMinute", "globalPerDay"],
    ),
    rakuten: section(
      secrets["rakuten"],
      settings["rakuten"],
      ["applicationId", "accessKey"],
      ["affiliateId", "allowedOrigin"],
    ),
    jev: section(secrets["jev"], settings["jev"], ["apiKey"], ["model"]),
    openai: section(secrets["openai"], settings["openai"], ["apiKey"], ["model"]),
    accesstrade: secrets["accesstrade"] ?? null,
    securitiesAffiliates: settings["securitiesAffiliates"] ?? null,
    commerce: {
      satofull: section(
        commerceSecrets["satofull"],
        commerceSettings["satofull"],
        ["token"],
        ["siteId", "spaceId", "aiAuthorized"],
      ),
      yahoo: section(
        commerceSecrets["yahoo"],
        commerceSettings["yahoo"],
        ["token", "applicationId"],
        ["siteId", "spaceId", "affiliateId", "aiAuthorized"],
      ),
      amazon: section(
        commerceSecrets["amazon"],
        commerceSettings["amazon"],
        ["clientId", "clientSecret"],
        ["partnerTag", "credentialVersion"],
      ),
    },
  };
}

function table(input: unknown): string {
  if (typeof input !== "string" || !/^[a-zA-Z0-9_.-]{3,255}$/.test(input)) {
    throw new Error("A fixed DynamoDB table name is required");
  }
  return input;
}
export function lambdaStorageConfiguration(
  input: unknown,
): Readonly<{ jobs: string; categories: string; limits: string }> {
  if (!record(input)) {
    throw new Error("DynamoDB storage configuration is required");
  }
  const result = {
    jobs: table(input["jobs"]),
    categories: table(input["categories"]),
    limits: table(input["limits"]),
  };
  if (new Set(Object.values(result)).size !== 3) {
    throw new Error("Separate DynamoDB tables are required");
  }
  return result;
}
function configuration(
  input: unknown,
): Readonly<{
  rakuten: unknown;
  openai: unknown;
  jev: unknown;
  commerce: unknown;
  accesstrade: Readonly<{ wsId: string }> | null;
  securitiesAffiliates: unknown;
  accessToken: string;
  allowedOrigin: string;
  globalPerMinute: number;
  globalPerDay: number;
}> {
  if (
    !record(input) ||
    !("rakuten" in input) ||
    !("openai" in input) ||
    !record(input["http"]) ||
    input["storage"] !== undefined ||
    typeof input["http"]["accessToken"] !== "string" ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(input["http"]["accessToken"]) ||
    typeof input["http"]["allowedOrigin"] !== "string"
  ) {
    throw new Error("Valid API_CONFIGURATION with http and no legacy PHP storage is required");
  }
  const origin = new URL(input["http"]["allowedOrigin"]);
  if (origin.protocol !== "https:" || origin.origin !== input["http"]["allowedOrigin"]) {
    throw new Error("A production HTTPS origin is required");
  }
  const accesstrade = input["accesstrade"];
  if (
    accesstrade !== undefined &&
    accesstrade !== null &&
    (!record(accesstrade) ||
      Object.keys(accesstrade).length !== 1 ||
      typeof accesstrade["wsId"] !== "string" ||
      !/^[!-~]{1,512}$/u.test(accesstrade["wsId"]))
  ) {
    throw new Error("Invalid AccessTrade settings; expected wsId");
  }
  const globalPerMinute = input["http"]["globalPerMinute"] ?? 60;
  const globalPerDay = input["http"]["globalPerDay"] ?? 1000;
  if (
    typeof globalPerMinute !== "number" ||
    !Number.isSafeInteger(globalPerMinute) ||
    globalPerMinute < 1 ||
    globalPerMinute > 10000 ||
    typeof globalPerDay !== "number" ||
    !Number.isSafeInteger(globalPerDay) ||
    globalPerDay < 1 ||
    globalPerDay > 100000
  ) {
    throw new Error("Invalid global rate limits");
  }
  return {
    rakuten: input["rakuten"],
    openai: input["openai"],
    jev: input["jev"] ?? null,
    commerce: input["commerce"] ?? null,
    accesstrade:
      record(accesstrade) && typeof accesstrade["wsId"] === "string"
        ? { wsId: accesstrade["wsId"] }
        : null,
    securitiesAffiliates: input["securitiesAffiliates"] ?? null,
    accessToken: input["http"]["accessToken"],
    allowedOrigin: origin.origin,
    globalPerMinute,
    globalPerDay,
  };
}

export function createLambdaApi(
  input: unknown,
  workerArn: string,
  storageInput: unknown,
  database: DynamoDatabase = createDynamoDatabase(),
): (event: unknown) => Promise<ApiResponse> {
  const settings = configuration(input),
    tables = lambdaStorageConfiguration(storageInput);
  const jobStore = createDynamoComparisonJobStore(database, tables.jobs, systemTime);
  const internal = createApiHandler(true, settings.rakuten, settings.openai, settings.jev, {
    ...configuredHttpDependencies(settings),
    commerceConfiguration: settings.commerce,
    securitiesAffiliateConfiguration: settings.securitiesAffiliates,
    apiAccessToken: settings.accessToken,
    allowedOrigin: settings.allowedOrigin,
    jobStore,
    categoryCache: createDynamoCategoryCache(database, tables.categories),
    dispatchComparisonJob: createLambdaDispatcher(workerArn),
    redispatchQueued: true,
    runStore: async (status) => {
      try {
        const now = Date.now();
        await database.count(
          tables.limits,
          `run:${Math.floor(now / 86_400_000)}:${status}`,
          Math.ceil(now / 1000) + 30 * 86400,
        );
        return ok(null);
      } catch {
        return err({ code: "storage_unavailable" });
      }
    },
  });
  const consume = createDynamoRateLimiter(database, tables.limits, Date.now, {
    perMinute: settings.globalPerMinute,
    perDay: settings.globalPerDay,
  });
  return createLambdaHttpHandler(
    createPublicConsumerApi(internal, {
      accessToken: settings.accessToken,
      allowedOrigin: settings.allowedOrigin,
      allowCapabilityCancellation: true,
      consumeRateLimit: async (address) =>
        await consume(createHmac("sha256", settings.accessToken).update(address).digest("hex")),
    }),
    { allowedOrigin: settings.allowedOrigin },
  );
}

export function createLambdaWorker(
  input: unknown,
  storageInput: unknown,
  database: DynamoDatabase = createDynamoDatabase(),
): (event: unknown) => Promise<void> {
  const settings = configuration(input),
    tables = lambdaStorageConfiguration(storageInput);
  const store = createDynamoComparisonJobStore(database, tables.jobs, systemTime);
  const run = createPersistedComparisonJobRunner(
    settings.rakuten,
    settings.jev,
    store,
    1500,
    createDynamoCategoryCache(database, tables.categories),
  );
  return async (event) => {
    if (
      !record(event) ||
      Object.keys(event).length !== 1 ||
      typeof event["jobId"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(event["jobId"])
    ) {
      throw new Error("Invalid worker event");
    }
    await run(event["jobId"]);
  };
}

export function createLambdaCleanup(
  jobsTable: unknown,
  database: DynamoDatabase = createDynamoDatabase(),
): (event: unknown) => Promise<void> {
  const store = createDynamoComparisonJobStore(database, table(jobsTable), systemTime);
  return async (event) => {
    if (!record(event) || Object.keys(event).length !== 1 || event["kind"] !== "cleanup") {
      throw new Error("Invalid cleanup event");
    }
    await store.cleanup();
  };
}
