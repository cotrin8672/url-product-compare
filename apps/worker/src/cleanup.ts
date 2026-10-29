import { createLambdaCleanup } from "../../../packages/backend/src/lambda-bootstrap.js";

let cleanup: ReturnType<typeof createLambdaCleanup> | undefined;
export async function handler(event: unknown): Promise<void> {
  if (cleanup === undefined) {
    try {
      cleanup = createLambdaCleanup(process.env["COMPARISON_JOBS_TABLE"]);
    } catch {
      throw new Error("Invalid cleanup configuration");
    }
  }
  await cleanup(event);
}
