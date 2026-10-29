import assert from "node:assert/strict";

const site = new URL(process.env.SITE_ORIGIN ?? "");
const api = new URL(process.env.PUBLIC_API_BASE ?? "");
for (const url of [site, api]) {
  assert.ok(
    url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    "Public HTTPS origins are required",
  );
}
async function request(url, init = {}) {
  return await globalThis.fetch(url, {
    ...init,
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
}
const page = await request(site);
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(
  html.includes(`name="api-base" content="${api.origin}"`),
  "Static build points to another API",
);
assert.ok(
  (page.headers.get("content-security-policy") ?? "").includes(api.origin),
  "CSP does not allow this Lambda",
);
for (const route of ["/api/catalog", "/api/commerce/sources"]) {
  const response = await request(new URL(route, api), { headers: { origin: site.origin } });
  assert.equal(response.status, 200, `Unavailable route: ${route}`);
  assert.equal(response.headers.get("access-control-allow-origin"), site.origin);
  const value = await response.json();
  assert.equal(value.tag, "ok");
}
for (const route of ["/api/detect", `/api/comparisons/${"a".repeat(64)}/cancel`]) {
  const response = await request(new URL(route, api), {
    method: "OPTIONS",
    headers: {
      origin: site.origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-comparison-key",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), site.origin);
}
const rejected = await request(new URL("/api/catalog", api), {
  headers: { origin: "https://unexpected.invalid" },
});
assert.equal(rejected.status, 403);
// An empty lookup exercises shared DynamoDB rate limiting without calling a provider.
const invalid = await request(new URL("/api/commerce", api), {
  method: "POST",
  headers: { origin: site.origin, "content-type": "application/json" },
  body: "{}",
});
assert.equal(invalid.status, 400, "Shared limits or API validation is unavailable");
for (const route of [
  "/.env",
  "/compare-storage/index.php",
  "/compare-storage/config.php",
  "/compare-storage/bridge.php",
  "/installation/schema.sql",
]) {
  const response = await request(new URL(route, site));
  assert.ok([403, 404].includes(response.status), `Private path must be unavailable: ${route}`);
}
console.log(
  "Migration smoke checks passed: static origin/CSP, catalog, commerce, preflight, origin rejection, DynamoDB rate limits and private paths. No provider calls made.",
);
