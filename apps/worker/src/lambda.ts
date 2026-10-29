import { createLambdaWorker } from "../../../packages/backend/src/lambda-bootstrap.js";

let worker: ReturnType<typeof createLambdaWorker> | undefined;

export async function handler(event: unknown): Promise<void> {
  if (worker === undefined) {
    try {
      const raw: unknown = JSON.parse(process.env["API_CONFIGURATION"] ?? "null");
      worker = createLambdaWorker(raw, {
        jobs: process.env["COMPARISON_JOBS_TABLE"],
        categories: process.env["COMPARISON_CATEGORIES_TABLE"],
        limits: process.env["COMPARISON_LIMITS_TABLE"],
      });
    } catch {
      throw new Error("Invalid Lambda configuration");
    }
  }
  await worker(event);
}
