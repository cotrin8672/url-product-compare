import assert from "node:assert/strict";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashLambdaPackage } from "./lambda-package-integrity.mjs";

const bundle = new URL("../apps/api/dist/lambda/", import.meta.url);
const bundlePath = await realpath(fileURLToPath(bundle));
let archiveBytes = 0;
let archiveFiles = 0;
// AWS CLI follows directory links when packaging. Check its expanded tree,
// including duplicate paths, so pnpm links cannot hide an oversized archive.
async function inspect(directory, ancestors = new Set()) {
  assert.equal(
    (await lstat(directory)).isSymbolicLink(),
    false,
    "Lambda archive must not depend on filesystem links",
  );
  const resolved = await realpath(directory);
  assert.ok(
    resolved === bundlePath || resolved.startsWith(`${bundlePath}${path.sep}`),
    `Lambda package link escapes the bundle: ${directory} -> ${resolved}`,
  );
  assert.equal(ancestors.has(resolved), false, "Lambda package contains a directory-link cycle");
  const parents = new Set([...ancestors, resolved]);
  for (const entry of await readdir(directory)) {
    const target = path.join(directory, entry);
    assert.equal(
      (await lstat(target)).isSymbolicLink(),
      false,
      "Lambda archive must contain a physical dependency tree",
    );
    assert.ok(
      !/^(?:\.env(?:\..*)?|api-configuration\.json|config\.php)$/.test(entry),
      "Private configuration in Lambda archive",
    );
    const information = await stat(target);
    if (information.isDirectory()) {
      await inspect(target, parents);
    } else {
      const resolvedFile = await realpath(target);
      assert.ok(
        resolvedFile.startsWith(`${bundlePath}${path.sep}`),
        "Lambda file link escapes the bundle",
      );
      archiveBytes += information.size;
      archiveFiles += 1;
      assert.ok(archiveBytes < 250 * 1024 * 1024, "Lambda expanded archive exceeds 250 MB");
    }
  }
}
await inspect(bundlePath);
// Validate every package's runtime dependency resolution, including transitive
// packages. Checking only handler imports can silently use workspace packages.
async function checkManifestDependencies(target) {
  const metadata = JSON.parse(await readFile(target, "utf8"));
  if (metadata.name !== undefined && metadata.version !== undefined) {
    const identity = `${metadata.name}@${metadata.version}`;
    installedPackages.add(identity);
    if (locked.hashes[identity] !== undefined) {
      assert.equal(
        await hashLambdaPackage(path.dirname(target)),
        locked.hashes[identity],
        `Package bytes differ from frozen install: ${identity}`,
      );
    }
  }
  const require = createRequire(target);
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    // A valid dependency may expose only subpaths, with no bare main export.
    // Follow Node's package search directories rather than demanding a main.
    const search = require.resolve.paths(dependency);
    assert.ok(Array.isArray(search), `Invalid dependency: ${dependency}`);
    let resolved;
    for (const directory of search) {
      try {
        resolved = await realpath(path.join(directory, dependency, "package.json"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    assert.ok(resolved !== undefined, `Missing runtime dependency: ${dependency}`);
    assert.ok(
      resolved.startsWith(`${bundlePath}${path.sep}`),
      `Dependency resolves outside archive: ${dependency}`,
    );
    const dependencyMetadata = JSON.parse(await readFile(resolved, "utf8"));
    const edge = `${metadata.name}@${metadata.version ?? ""}>${dependency}`;
    assert.equal(
      `${dependencyMetadata.name}@${dependencyMetadata.version}`,
      locked.edges[edge],
      `Dependency edge drifted: ${edge}`,
    );
  }
}
async function checkDependencies(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDependencies(target);
    } else if (entry.name === "package.json") {
      await checkManifestDependencies(target);
    }
  }
}
const installedPackages = new Set();
const locked = JSON.parse(
  await readFile(path.join(bundlePath, "dependency-lock-snapshot.json"), "utf8"),
);
assert.equal(
  locked.lockSha256,
  (await import("node:crypto"))
    .createHash("sha256")
    .update(await readFile(new URL("../pnpm-lock.yaml", import.meta.url)))
    .digest("hex"),
  "Bundle does not match the current workspace lockfile",
);
await checkManifestDependencies(path.join(bundlePath, "package.json"));
installedPackages.clear();
await checkDependencies(path.join(bundlePath, "node_modules"));
assert.deepEqual(
  [...installedPackages].sort(),
  locked.packages,
  "Portable dependencies drifted from the frozen workspace",
);
await access(new URL("node_modules/@aws-sdk/client-lambda/package.json", bundle));
await access(new URL("node_modules/@aws-sdk/client-dynamodb/package.json", bundle));
await assert.rejects(
  access(new URL("packages/backend/src/infrastructure/xserver/bridge.js", bundle)),
);
await assert.rejects(access(new URL("node_modules/firebase-admin/package.json", bundle)));
await assert.rejects(access(new URL("node_modules/firebase-functions/package.json", bundle)));
const api = await import(new URL("apps/api/src/lambda.js", bundle));
const worker = await import(new URL("apps/worker/src/lambda.js", bundle));
const cleanup = await import(new URL("apps/worker/src/cleanup.js", bundle));
assert.equal(typeof api.handler, "function");
assert.equal(typeof worker.handler, "function");
assert.equal(typeof cleanup.handler, "function");
const originalConfiguration = process.env.API_CONFIGURATION;
try {
  process.env.API_CONFIGURATION = '{"private-provider-key":"do-not-log';
  await assert.rejects(api.handler({}), { message: "Invalid Lambda configuration" });
  await assert.rejects(worker.handler({}), { message: "Invalid Lambda configuration" });
} finally {
  if (originalConfiguration === undefined) {
    delete process.env.API_CONFIGURATION;
  } else {
    process.env.API_CONFIGURATION = originalConfiguration;
  }
}
const manifest = JSON.parse(await readFile(new URL("package.json", bundle), "utf8"));
assert.equal(manifest.type, "module");
assert.equal(manifest.devDependencies, undefined);
const template = JSON.parse(
  await readFile(new URL("../infrastructure/lambda/template.json", import.meta.url), "utf8"),
);
assert.equal(
  template.Resources.HttpApi,
  undefined,
  "Synchronous routes must not go through the 30-second HTTP API limit",
);
assert.equal(template.Resources.Api.Properties.Timeout, 90);
assert.deepEqual(template.Resources.Api.Properties.FunctionUrlConfig, {
  AuthType: "NONE",
  InvokeMode: "BUFFERED",
});
assert.equal(template.Resources.Worker.Properties.FunctionUrlConfig, undefined);
assert.equal(template.Resources.Worker.Properties.Events, undefined);
assert.equal(template.Parameters.ConcurrencyMode.Default, "reserved");
assert.deepEqual(template.Parameters.ConcurrencyMode.AllowedValues, ["reserved", "shared"]);
assert.deepEqual(template.Conditions.UseReservedConcurrency, {
  "Fn::Equals": [{ Ref: "ConcurrencyMode" }, "reserved"],
});
for (const [name, reserved] of [
  ["Api", { Ref: "ApiConcurrency" }],
  ["Worker", { Ref: "WorkerConcurrency" }],
  ["Cleanup", 1],
]) {
  assert.deepEqual(template.Resources[name].Properties.ReservedConcurrentExecutions, {
    "Fn::If": ["UseReservedConcurrency", reserved, { Ref: "AWS::NoValue" }],
  });
}
assert.equal(template.Resources.Cleanup.Properties.FunctionUrlConfig, undefined);
assert.equal(
  template.Resources.Cleanup.Properties.Events.Sweep.Properties.Schedule,
  "rate(1 minute)",
);
assert.deepEqual(JSON.parse(template.Resources.Cleanup.Properties.Events.Sweep.Properties.Input), {
  kind: "cleanup",
});
assert.equal(template.Globals.Function.Environment.Variables.API_CONFIGURATION, undefined);
assert.deepEqual(template.Globals.Function.Environment.Variables.APPLICATION_CONFIGURATION, {
  Ref: "ApplicationConfiguration",
});
assert.equal(template.Parameters.ApplicationConfiguration.Type, "String");
assert.equal(template.Resources.Cleanup.Properties.Environment, undefined);
for (const name of ["Jobs", "Categories", "Limits"]) {
  assert.equal(template.Resources[name].Type, "AWS::DynamoDB::Table");
  assert.equal(template.Resources[name].Properties.BillingMode, "PAY_PER_REQUEST");
  assert.deepEqual(template.Resources[name].Properties.TimeToLiveSpecification, {
    AttributeName: "ttl",
    Enabled: true,
  });
  assert.equal(template.Resources[name].DeletionPolicy, "Retain");
}
const statements = (name) =>
  template.Resources[name].Properties.Policies.filter(
    (policy) => typeof policy === "object",
  ).flatMap((policy) => policy.Statement);
const actions = (name) =>
  statements(name)
    .flatMap((statement) => statement.Action)
    .sort();
assert.deepEqual(actions("Cleanup"), [
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:Query",
]);
assert.deepEqual(actions("Worker"), [
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
]);
for (const name of ["Api", "Worker", "Cleanup"]) {
  for (const statement of statements(name)) {
    assert.notEqual(
      statement.Resource,
      "*",
      "Application permissions require fixed resource scopes",
    );
  }
}
assert.deepEqual(
  statements("Cleanup").map((statement) => statement.Resource),
  [{ "Fn::GetAtt": ["Jobs", "Arn"] }, { "Fn::Sub": "${Jobs.Arn}/index/cleanup" }],
);
assert.deepEqual(template.Outputs.ApiOrigin.Value, { "Fn::GetAtt": ["ApiUrl", "FunctionUrl"] });
const { createLambdaHttpHandler } = await import(
  new URL("packages/backend/src/infrastructure/aws/http.js", bundle)
);
const handler = createLambdaHttpHandler(async () => ({ statusCode: 200, headers: {}, body: "ok" }));
assert.equal((await handler({ jobId: "a".repeat(64) })).statusCode, 400);
assert.equal(
  (
    await handler({
      version: "2.0",
      rawPath: "/api/health",
      rawQueryString: "",
      headers: {},
      isBase64Encoded: false,
      requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
    })
  ).statusCode,
  200,
);
console.log(
  `Lambda package: ${archiveFiles} expanded files, ${archiveBytes} bytes; API/worker/cleanup import without Firebase or PHP bridge; DynamoDB, schedule, Function URL and HTTP envelope checked.`,
);
