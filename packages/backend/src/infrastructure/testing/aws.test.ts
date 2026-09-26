import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiHandler } from "../../bootstrap.js";
import { createAuroraRunStore } from "../aws/aurora.js";
import { parseApiRequest } from "../http/request.js";

const event = {
  version: "2.0",
  rawPath: "/api/investigate",
  rawQueryString: "",
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" }),
  isBase64Encoded: false,
} as const;

await test("Lambda boundary validates unknown input before comparison", async () => {
  const handler = createApiHandler(null);
  assert.equal((await handler(event)).statusCode, 200);
  for (const input of [
    null,
    {},
    { ...event, body: "{" },
    { ...event, body: "[]" },
    { ...event, isBase64Encoded: true },
    { ...event, body: JSON.stringify({ url: "x".repeat(2049) }) },
  ]) {
    assert.equal((await handler(input)).statusCode, 400);
  }
  assert.equal((await handler({ ...event, rawPath: "/missing" })).statusCode, 404);
  assert.equal(
    (await handler({ ...event, requestContext: { http: { method: "DELETE" } } })).statusCode,
    405,
  );
  assert.equal(
    (await handler({ ...event, body: JSON.stringify({ url: "https://example.com/" }) })).statusCode,
    422,
  );
  assert.equal(
    (
      await handler({
        ...event,
        rawPath: "/api/health",
        requestContext: { http: { method: "GET" } },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    parseApiRequest({
      ...event,
      requestContext: { http: { method: "GET" } },
      rawQueryString: "url=a&url=b",
    }).tag,
    "err",
  );
});

await test("Aurora writes bound metadata only and contains storage errors", async () => {
  const store = createAuroraRunStore("cluster", "secret", "compare", (input) => {
    assert.equal(
      input.sql,
      "INSERT INTO investigation_runs (mode, status) VALUES ('demo', :status)",
    );
    assert.deepEqual(input.parameters, [{ name: "status", value: { stringValue: "succeeded" } }]);
    assert.equal(JSON.stringify(input).includes("rakuten"), false);
    return Promise.resolve({});
  });
  assert.deepEqual(await store("succeeded"), { tag: "ok", value: null });
  const unavailable = createAuroraRunStore("cluster", "secret", "compare", () =>
    Promise.reject(new Error("private credential")),
  );
  assert.deepEqual(await unavailable("failed"), {
    tag: "err",
    error: { code: "storage_unavailable" },
  });
});
