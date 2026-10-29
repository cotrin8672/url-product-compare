import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Read the ignored local file without printing configuration or parser errors.
try {
  const source = await readFile(
    new URL("../infrastructure/lambda/api-configuration.json", import.meta.url),
    "utf8",
  );
  const configuration = JSON.parse(source);
  // Leave room for Lambda's other environment variable names and values.
  assert.ok(Buffer.byteLength(source, "utf8") <= 3400);
  const { createLambdaApi, createLambdaWorker } = await import(
    new URL("../apps/api/dist/lambda/packages/backend/src/lambda-bootstrap.js", import.meta.url)
  );
  createLambdaApi(
    configuration,
    "arn:aws:lambda:ap-northeast-1:123456789012:function:configuration-check",
    {
      jobs: "configuration-check-jobs",
      categories: "configuration-check-categories",
      limits: "configuration-check-limits",
    },
  );
  createLambdaWorker(configuration, {
    jobs: "configuration-check-jobs",
    categories: "configuration-check-categories",
    limits: "configuration-check-limits",
  });
  console.log(
    "Lambda configuration passed schema, origin and environment-size checks. No credentials printed or provider calls made.",
  );
} catch {
  console.error(
    "Invalid or missing infrastructure/lambda/api-configuration.json. Build lambda:package first; check provider fields, HTTPS origins, remove legacy storage/bridge secrets and use JSON <= 3400 UTF-8 bytes. Configuration values are never printed.",
  );
  process.exitCode = 1;
}
