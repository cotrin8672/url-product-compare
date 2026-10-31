import {
  combineLambdaConfiguration,
  createLambdaApi,
} from "../../../packages/backend/src/lambda-bootstrap.js";

let api: ReturnType<typeof createLambdaApi> | undefined;

export async function handler(event: unknown): ReturnType<ReturnType<typeof createLambdaApi>> {
  if (api === undefined) {
    try {
      const raw: unknown = JSON.parse(process.env["API_CONFIGURATION"] ?? "null");
      const settings: unknown = JSON.parse(process.env["APPLICATION_CONFIGURATION"] ?? "null");
      api = createLambdaApi(
        combineLambdaConfiguration(raw, settings),
        process.env["COMPARISON_WORKER_ARN"] ?? "",
        {
          jobs: process.env["COMPARISON_JOBS_TABLE"],
          categories: process.env["COMPARISON_CATEGORIES_TABLE"],
          limits: process.env["COMPARISON_LIMITS_TABLE"],
        },
      );
    } catch {
      // Parser and URL errors can contain fragments of secret configuration.
      throw new Error("Invalid Lambda configuration");
    }
  }
  return await api(event);
}
