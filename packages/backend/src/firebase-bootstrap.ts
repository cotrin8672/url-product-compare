import { defineJsonSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import type { HttpsFunction } from "firebase-functions/v2/https";

import {
  createApiHandler,
  createPublicConsumerApi,
  configuredHttpDependencies,
  createPersistedComparisonJobRunner,
  systemTime,
} from "./bootstrap.js";
import { err } from "./comparison/algebra.js";
import { record } from "./comparison/values.js";
import {
  createFirestoreComparisonJobStore,
  createFirestoreRunStore,
} from "./infrastructure/firebase/firestore.js";
import { apiResponse } from "./infrastructure/http/request.js";
import type { ApiResponse } from "./infrastructure/http/request.js";

export function createFirebaseApi(): HttpsFunction {
  const configuration = defineJsonSecret<unknown>("API_CONFIGURATION");
  let handler: ReturnType<typeof createPublicConsumerApi> | null = null;
  return onRequest(
    {
      region: "asia-northeast1",
      invoker: "public",
      secrets: [configuration],
      minInstances: 0,
      maxInstances: 2,
      concurrency: 10,
      memory: "256MiB",
      timeoutSeconds: 60,
    },
    async (request, response) => {
      let result: ApiResponse;
      try {
        const body = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.alloc(0);
        if (body.length > 4096) {
          result = apiResponse(413, err({ code: "invalid_request" }));
        } else {
          // Secrets are available at runtime, after Firebase's deployment discovery.
          if (handler === null) {
            const settings = configuration.value();
            if (!record(settings) || !("rakuten" in settings) || !("openai" in settings)) {
              throw new Error("API_CONFIGURATION requires rakuten and openai settings or null");
            }
            const dependencies = configuredHttpDependencies(settings["http"]);
            const internal = createApiHandler(
              true,
              settings["rakuten"],
              settings["openai"],
              settings["jev"] ?? null,
              {
                ...dependencies,
                commerceConfiguration: settings["commerce"] ?? null,
                jobStore: createFirestoreComparisonJobStore(systemTime),
                runStore: createFirestoreRunStore(),
              },
            );
            const rakuten = settings["rakuten"];
            const accessToken =
              dependencies.apiAccessToken ??
              (record(rakuten) && typeof rakuten["accessToken"] === "string"
                ? rakuten["accessToken"]
                : null);
            const origin =
              dependencies.allowedOrigin ??
              (record(rakuten) && typeof rakuten["allowedOrigin"] === "string"
                ? rakuten["allowedOrigin"]
                : undefined);
            handler = createPublicConsumerApi(internal, {
              accessToken,
              ...(origin === undefined ? {} : { allowedOrigin: origin }),
            });
          }
          const route = new URL(request.originalUrl, "http://localhost");
          const socket: unknown = request.socket;
          const address =
            record(socket) && typeof socket["remoteAddress"] === "string"
              ? socket["remoteAddress"]
              : "unknown";
          const protocol: unknown = request.protocol;
          const hostname: unknown = request.hostname;
          const serverOrigin =
            typeof protocol === "string" && typeof hostname === "string"
              ? `${protocol}://${hostname}`
              : undefined;
          result = await handler(
            {
              path: route.pathname,
              method: request.method,
              query: route.search.slice(1),
              headers: request.headers,
              body: body.toString("utf8"),
            },
            address,
            serverOrigin,
          );
        }
      } catch {
        result = apiResponse(500, err({ code: "internal_error" }));
      }
      response.status(result.statusCode).set(result.headers).send(result.body);
    },
  );
}

export function createComparisonJobWorkerTrigger(): ReturnType<typeof onDocumentCreated> {
  const configuration = defineJsonSecret<unknown>("API_CONFIGURATION");
  let runJob: ((jobId: string) => Promise<void>) | null = null;
  return onDocumentCreated(
    {
      document: "comparison_jobs/{jobId}",
      region: "asia-northeast1",
      secrets: [configuration],
      timeoutSeconds: 60,
      memory: "512MiB",
      retry: true,
    },
    async (event) => {
      const jobId = event.params["jobId"];
      if (typeof jobId !== "string") {
        return;
      }
      if (runJob === null) {
        const settings = configuration.value();
        if (!record(settings) || !("rakuten" in settings) || !("openai" in settings)) {
          throw new Error("API_CONFIGURATION requires rakuten and openai settings or null");
        }
        runJob = createPersistedComparisonJobRunner(
          settings["rakuten"],
          settings["jev"] ?? null,
          createFirestoreComparisonJobStore(systemTime),
          250,
        );
      }
      await runJob(jobId);
    },
  );
}
