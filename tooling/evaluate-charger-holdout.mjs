import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { parseChargerComparison, parseInvestigation } from "../packages/api-client/dist/index.js";
import { createApiHandler } from "../packages/backend/dist/bootstrap.js";
import {
  assessCharging,
  chargerSpecificationSchema,
  chargingContextSchema,
} from "../packages/backend/dist/comparison/charger.js";
import { instant } from "../packages/backend/dist/comparison/values.js";

const baseline = process.argv.includes("--baseline");
const caseBytes = readFileSync("docs/charger-holdout-cases.json");
const inputSha256 = createHash("sha256").update(caseBytes).digest("hex");
// Pin after formatting, before running either phase or registering the product.
assert.equal(inputSha256, "caab664a84aad14440b00f653479423761b8692fa990a19711a22d50c1694cd8");
const gold = JSON.parse(caseBytes.toString("utf8"));
const fetchedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(fetchedAt) + 900_000).toISOString();
const now = instant(fetchedAt);
assert.equal(now.tag, "ok");
const specification = chargerSpecificationSchema.parse({
  kind: "ac-usb-c-charger",
  productId: gold.model,
  evidence: { provider: "elecom", source: gold.url, observedAt: fetchedAt },
  permissions: {
    fetch: { status: "granted", expiresAt },
    display: { status: "granted", expiresAt },
    store: { status: "denied" },
    ai: { status: "denied" },
    affiliate: { status: "denied" },
  },
  expiresAt,
  input: { plug: "jp-a", minVoltageV: 100, maxVoltageV: 240, frequenciesHz: [50, 60] },
  limits: { maxDevices: 1, maxTotalPowerW: 65 },
  configurationsComplete: true,
  configurations: [
    {
      maxTotalPowerW: 65,
      ports: [
        {
          port: "C1",
          maxPowerW: 65,
          profiles: [
            ...gold.pd.map(([voltageV, currentA]) => ({ protocol: "pd", voltageV, currentA })),
            ...gold.pps.map(([minVoltageV, maxVoltageV, currentA]) => ({
              protocol: "pps",
              minVoltageV,
              maxVoltageV,
              currentA,
            })),
          ],
        },
      ],
    },
  ],
});
assert.equal(specification.tag, "ok");
const realFetch = globalThis.fetch;
const snapshots = new Map();
const urls = baseline
  ? [gold.url]
  : [
      gold.url,
      ...Object.values(JSON.parse(readFileSync("docs/charger-quality-cases.json", "utf8")).sources),
    ];
for (const url of urls) {
  const response = await realFetch(url, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200);
  snapshots.set(url, await response.text());
}
const normalized = snapshots
  .get(gold.url)
  .replace(/<[^>]*>/g, "")
  .replace(/\s+/g, "");
assert.ok(normalized.includes(`JANコード:${gold.gtin}`));
for (const [key, value] of gold.specificationRows) {
  assert.ok(normalized.includes(`${key}${value}`), `Official specification changed: ${key}`);
}
// Real HTTP once per product, memory-only reuse through the production parser for every case.
let calls = 0;
globalThis.fetch = (url) => {
  calls++;
  assert.ok(snapshots.has(url));
  return Promise.resolve(
    new globalThis.Response(snapshots.get(url), { headers: { "content-type": "text/html" } }),
  );
};
const handler = createApiHandler(false);
const request = (body) =>
  handler({ path: "/api/investigate", query: "", method: "POST", body: JSON.stringify(body) });
const rows = [];
let lookup;
try {
  const response = await request({ url: gold.url });
  lookup = { status: response.statusCode, body: JSON.parse(response.body), fetchCalls: calls };
  if (baseline) {
    assert.equal(response.statusCode, 422);
    assert.equal(lookup.body.error.code, "unsupported_official_url");
    assert.equal(calls, 0);
  } else {
    const product = parseInvestigation(lookup.body);
    assert.equal(response.statusCode, 200);
    assert.equal(product.productId, gold.model);
    assert.equal(product.gtin, gold.gtin);
    assert.equal(product.portCount, 1);
  }
  for (const item of gold.cases) {
    const devices = item.devices.map(([protocol, voltageV, currentA, amps, volts = 20], index) => ({
      id: `device-${index + 1}`,
      protocol,
      voltageV,
      currentA,
      cable: amps === null ? null : { maxCurrentA: amps, maxVoltageV: volts },
    }));
    const context = chargingContextSchema.parse({ devices });
    assert.equal(context.tag, "ok");
    const engine = assessCharging(specification.value, context.value, now.value);
    const expected = item.expected;
    const row = {
      id: item.id,
      expected,
      engine,
      engineAgrees: engine.status === expected && engine.reason === item.reason,
    };
    if (!baseline) {
      const response = await request({
        url: gold.url,
        operation: "compare",
        confirmed: true,
        conditions: { devices, portPreference: "ignore", plugPreference: "ignore" },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = parseChargerComparison(JSON.parse(response.body));
      const product = result.products.find((entry) => entry.productId === gold.model);
      assert.ok(product?.isSource);
      const expectedStatus = {
        compatible: "eligible",
        incompatible: "excluded",
        unknown: "pending",
      }[expected];
      row.api = {
        status: product.status,
        assignments: product.assignments,
        reasons: product.reasons,
      };
      row.apiAgrees = product.status === expectedStatus;
      if (expected === "compatible") {
        assert.deepEqual(product.assignments, [{ deviceId: "device-1", port: "C1" }]);
      }
    }
    rows.push(row);
  }
} finally {
  globalThis.fetch = realFetch;
}
const summary = {
  cases: rows.length,
  engineAgrees: rows.filter((row) => row.engineAgrees).length,
  apiAgrees: baseline ? null : rows.filter((row) => row.apiAgrees).length,
  falseCompatible: rows.filter(
    (row) =>
      (row.engine.status === "compatible" || row.api?.status === "eligible") &&
      row.expected !== "compatible",
  ).length,
  falseExcluded: rows.filter(
    (row) =>
      (row.engine.status === "incompatible" || row.api?.status === "excluded") &&
      row.expected !== "incompatible",
  ).length,
  pending: rows.filter((row) => row.engine.status === "unknown").length,
};
writeFileSync(
  `docs/charger-holdout-${baseline ? "baseline" : "results"}.json`,
  `${JSON.stringify(
    {
      inputSha256,
      fetchedAt,
      phase: baseline ? "before-product-registration" : "after-product-registration",
      realManufacturerRequests: urls.length,
      scope: gold.scope,
      lookup,
      summary,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(summary));
assert.equal(summary.engineAgrees, summary.cases);
assert.equal(summary.apiAgrees, baseline ? null : summary.cases);
