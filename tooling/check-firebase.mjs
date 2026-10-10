import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URLSearchParams } from "node:url";

const bundle = new URL("../apps/api/dist/firebase/", import.meta.url);
const { api, comparisonJobWorker } = await import(new URL("apps/api/src/firebase.js", bundle));
const require = createRequire(new URL("package.json", bundle));
const {
  CollectionReference,
  DocumentReference,
  FieldValue,
  Query,
  Timestamp,
} = require("firebase-admin/firestore");
const originalAdd = CollectionReference.prototype.add;
const originalQueryGet = Query.prototype.get;
const originalDocumentGet = DocumentReference.prototype.get;
let reads = 0;
function unexpectedRead() {
  reads += 1;
  throw new Error("Current API routes must not read Firestore");
}
Query.prototype.get = unexpectedRead;
DocumentReference.prototype.get = unexpectedRead;
const writes = [];
let failStorage = false;
CollectionReference.prototype.add = async function (metadata) {
  assert.equal(this.id, "investigation_runs");
  if (failStorage) {
    throw new Error("private credential");
  }
  assert.deepEqual(Object.keys(metadata), ["mode", "status", "createdAt", "expiresAt"]);
  assert.equal(metadata.createdAt.isEqual(FieldValue.serverTimestamp()), true);
  assert.ok(metadata.expiresAt instanceof Timestamp);
  assert.ok(Math.abs(metadata.expiresAt.toMillis() - Date.now() - 30 * 24 * 60 * 60 * 1000) < 5000);
  writes.push(metadata);
  return {};
};
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Package checks must never call external services");
};
async function request(method, originalUrl, body = "", headers = {}) {
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(values) {
      this.headers = values;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
  await api(
    { method, originalUrl, ...(body === "" ? {} : { rawBody: Buffer.from(body) }), headers },
    response,
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  return response;
}
try {
  assert.equal(comparisonJobWorker.__endpoint.eventTrigger.retry, true);
  assert.equal(comparisonJobWorker.__endpoint.platform, "gcfv2");
  assert.equal(comparisonJobWorker.__endpoint.region[0], api.__endpoint.region[0]);
  assert.equal(comparisonJobWorker.__endpoint.timeoutSeconds, 60);
  const health = await request("GET", "/api/health");
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).mode, "demo");
  assert.equal(writes.length, 0);
  const body = JSON.stringify({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" });
  assert.equal((await request("POST", "/api/investigate", body)).statusCode, 200);
  assert.equal(writes.length, 1);
  const comparison = await request(
    "POST",
    "/api/investigate",
    JSON.stringify({
      url: "https://item.rakuten.co.jp/demo-shop/demo-product/",
      operation: "compare",
      confirmed: true,
      conditions: {
        devices: [
          {
            id: "phone",
            protocol: "pd",
            voltageV: 5,
            currentA: 3,
            cable: { maxCurrentA: 3, maxVoltageV: 20 },
          },
        ],
        portPreference: "ignore",
        plugPreference: "ignore",
      },
    }),
  );
  assert.equal(comparison.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, "succeeded");
  assert.equal(
    (
      await request(
        "GET",
        `/api/investigate?${new URLSearchParams({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" })}`,
      )
    ).statusCode,
    200,
  );
  assert.equal(writes.length, 1);
  assert.equal((await request("POST", "/api/investigate", "{")).statusCode, 400);
  assert.equal(
    (await request("POST", "/api/candidates", JSON.stringify({ requirements: "65W charger" })))
      .statusCode,
    401,
  );
  assert.equal((await request("DELETE", "/api/investigate")).statusCode, 405);
  assert.equal((await request("GET", "/api/missing")).statusCode, 404);
  assert.equal((await request("POST", "/api/investigate", "あ".repeat(1400))).statusCode, 413);
  assert.equal(writes.length, 1);
  const failure = await request(
    "POST",
    "/api/investigate",
    JSON.stringify({ url: "https://example.com/" }),
  );
  assert.equal(failure.statusCode, 422);
  assert.equal(writes[1].status, "failed");
  failStorage = true;
  const unavailable = await request("POST", "/api/investigate", body);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(JSON.parse(unavailable.body).error.code, "storage_unavailable");
  assert.equal(unavailable.body.includes("private credential"), false);
  assert.equal(reads, 0);
  const config = JSON.parse(await readFile(new URL("../firebase.json", import.meta.url), "utf8"));
  assert.equal(config.functions.runtime, "nodejs22");
  assert.equal(config.hosting.rewrites[0].function.functionId, "api");
  assert.equal(config.hosting.rewrites[0].function.region, api.__endpoint.region[0]);
  assert.equal(config.hosting.rewrites[1].destination, "/index.html");
  const indexes = JSON.parse(
    await readFile(new URL(`../${config.firestore.indexes}`, import.meta.url), "utf8"),
  );
  assert.deepEqual(indexes, {
    indexes: [],
    fieldOverrides: [
      { collectionGroup: "investigation_runs", fieldPath: "*", indexes: [] },
      { collectionGroup: "investigation_runs", fieldPath: "expiresAt", ttl: true, indexes: [] },
      { collectionGroup: "comparison_jobs", fieldPath: "*", indexes: [] },
      { collectionGroup: "comparison_jobs", fieldPath: "cleanupAt", ttl: true, indexes: [] },
    ],
  });
  const rules = await readFile(
    new URL("../infrastructure/firestore.rules", import.meta.url),
    "utf8",
  );
  assert.match(rules, /allow read, write: if false;/);
  console.log(
    "Firebase package: HTTP routes, zero Firestore reads, bounded metadata writes, TTL, index exemptions and storage failures passed without external calls.",
  );
} finally {
  CollectionReference.prototype.add = originalAdd;
  Query.prototype.get = originalQueryGet;
  DocumentReference.prototype.get = originalDocumentGet;
  globalThis.fetch = originalFetch;
}
