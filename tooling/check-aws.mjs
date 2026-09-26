import assert from "node:assert/strict";

import { handler } from "../apps/api/dist/lambda/apps/api/src/index.js";

const request = {
  version: "2.0",
  rawPath: "/api/investigate",
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" }),
  isBase64Encoded: false,
};
const response = await handler(request);
assert.equal(response.statusCode, 200);
assert.equal(JSON.parse(response.body).value.mode, "demo");
assert.equal(response.headers["cache-control"], "no-store");
assert.equal((await handler({ ...request, body: "{" })).statusCode, 400);
console.log(
  "Packaged Lambda: imports ESM and bundled SDK; demo and invalid input passed (no AWS calls).",
);
