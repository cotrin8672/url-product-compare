import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Read the ignored local file without printing configuration or parser errors.
try {
  const source = await readFile(
    new URL("../infrastructure/lambda/api-configuration.json", import.meta.url),
    "utf8",
  );
  const configuration = JSON.parse(source);
  const applicationSource = await readFile(
    new URL("../infrastructure/lambda/application-configuration.json", import.meta.url),
    "utf8",
  );
  const application = JSON.parse(applicationSource);
  // Leave room for Lambda's other environment variable names and values.
  assert.ok(Buffer.byteLength(source + applicationSource, "utf8") <= 3400);
  const { combineLambdaConfiguration, createLambdaApi, createLambdaWorker } = await import(
    new URL("../apps/api/dist/lambda/packages/backend/src/lambda-bootstrap.js", import.meta.url)
  );
  const combined = combineLambdaConfiguration(configuration, application);
  createLambdaApi(
    combined,
    "arn:aws:lambda:ap-northeast-1:123456789012:function:configuration-check",
    {
      jobs: "configuration-check-jobs",
      categories: "configuration-check-categories",
      limits: "configuration-check-limits",
    },
  );
  createLambdaWorker(combined, {
    jobs: "configuration-check-jobs",
    categories: "configuration-check-categories",
    limits: "configuration-check-limits",
  });
  console.log(
    "Lambda configuration passed schema, origin and environment-size checks. No credentials printed or provider calls made.",
  );
} catch {
  console.error(
    "Invalid or missing Lambda secret/application configuration files. Build lambda:package first; separate credentials from non-secret settings and keep combined JSON <= 3400 UTF-8 bytes. Configuration values are never printed.",
  );
  process.exitCode = 1;
}
