import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { parseChargerComparison, parseInvestigation } from "../packages/api-client/dist/index.js";
import { createApiHandler } from "../packages/backend/dist/bootstrap.js";

const caseBytes = readFileSync("docs/charger-quality-cases.json");
const inputSha256 = createHash("sha256").update(caseBytes).digest("hex");
assert.equal(
  inputSha256,
  "d434d4cfc816554d7a1fc24dc45aeb5f315ae721853a1391161c6cae9de28e4e",
  "The pre-labelled cases must remain frozen",
);
const gold = JSON.parse(caseBytes.toString("utf8"));
assert.equal(gold.cases.length, 32);
const sources = Object.entries(gold.sources);
const snapshots = new Map();
const realFetch = globalThis.fetch;
const fetchedAt = new Date().toISOString();
const catalogSources = [
  ...sources,
  ["MPA-AC12465BK", "https://www.elecom.co.jp/products/MPA-AC12465BK.html"],
];
for (const [model, url] of catalogSources) {
  const response = await realFetch(url, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200, model);
  assert.ok(response.headers.get("content-type")?.includes("text/html"));
  snapshots.set(url, await response.text());
}
let mutation = (html) => html;
let failFetch = false;
let calls = 0;
// Reuse this run's real HTTP snapshots to avoid 96 repeated manufacturer requests.
// Every case still runs the production identity, fingerprint, schema, comparison and client parsers.
globalThis.fetch = (url) => {
  calls++;
  assert.ok(snapshots.has(url), "Only reviewed manufacturer URLs may be fetched");
  return failFetch
    ? Promise.reject(new Error("Evaluation transport failure"))
    : Promise.resolve(
        new globalThis.Response(mutation(snapshots.get(url)), {
          headers: { "content-type": "text/html" },
        }),
      );
};
const handler = createApiHandler(false);
const request = (body) =>
  handler({ path: "/api/investigate", query: "", method: "POST", body: JSON.stringify(body) });
const rows = [];
const safeguards = [];
try {
  for (const item of gold.cases) {
    const conditions = {
      devices: item.devices.map(
        ([protocol, voltageV, currentA, cableAmps, cableVolts = 20], index) => ({
          id: `device-${index + 1}`,
          protocol,
          voltageV,
          currentA,
          cable: cableAmps === null ? null : { maxCurrentA: cableAmps, maxVoltageV: cableVolts },
        }),
      ),
      portPreference: "ignore",
      plugPreference: "ignore",
    };
    const response = await request({
      url: gold.sources["MPA-ACCP4365BK"],
      operation: "compare",
      confirmed: true,
      conditions,
    });
    assert.equal(response.statusCode, 200, `${item.id}: ${response.body}`);
    const result = parseChargerComparison(JSON.parse(response.body));
    assert.equal(result.mode, "official");
    for (const [index, [model]] of sources.entries()) {
      const product = result.products.find((entry) => entry.productId === model);
      assert.ok(product);
      rows.push({
        id: item.id,
        model,
        expected: item.expected[index],
        actual: product.status,
        agrees: item.expected[index] === product.status,
        reasons: product.reasons,
        assignments: product.assignments,
      });
    }
    if (item.id === "reversed-port-allocation") {
      assert.deepEqual(
        result.products.find((entry) => entry.productId === "MPA-AC113100BK").assignments,
        [
          { deviceId: "device-1", port: "C2" },
          { deviceId: "device-2", port: "C1" },
        ],
      );
    }
  }
  const conditions = {
    devices: [
      {
        id: "device-1",
        protocol: "pd",
        voltageV: 20,
        currentA: 2.25,
        cable: { maxCurrentA: 3, maxVoltageV: 20 },
      },
    ],
    portPreference: "ignore",
    plugPreference: "ignore",
  };
  for (const [id, change, status, code] of [
    [
      "changed-output",
      (html) => html.replaceAll("3.25A", "3.5A"),
      422,
      "official_specification_changed",
    ],
    [
      "changed-gtin",
      (html) => html.replaceAll("4549550281836", "4549550281829"),
      422,
      "official_specification_changed",
    ],
    [
      "changed-model",
      (html) => html.replaceAll("MPA-ACCP4365BK", "OTHER-MODEL"),
      422,
      "official_specification_changed",
    ],
    [
      "changed-weight",
      (html) => html.replaceAll("約106g", "約99g"),
      422,
      "official_specification_changed",
    ],
    ["unavailable-source", (html) => html, 503, "official_source_unavailable"],
  ]) {
    mutation = change;
    failFetch = id === "unavailable-source";
    const response = await request({
      url: gold.sources["MPA-ACCP4365BK"],
      operation: "compare",
      confirmed: true,
      conditions,
    });
    const body = JSON.parse(response.body);
    safeguards.push({ id, passed: response.statusCode === status && body.error?.code === code });
  }
  failFetch = false;
  mutation = (html) => html;
  const lookup = parseInvestigation(
    JSON.parse((await request({ url: gold.sources["MPA-ACCP4365BK"] })).body),
  );
  assert.equal(lookup.mode, "official");
  assert.equal(lookup.gtin, "4549550281836");
  assert.equal(lookup.color, "ブラック");
  for (const id of ["prefer_roles", "require_numbers"]) {
    const response = await request({
      url: lookup.canonicalUrl,
      operation: "compare",
      confirmed: true,
      conditions: { ...conditions, portPreference: id },
    });
    const result = parseChargerComparison(JSON.parse(response.body));
    safeguards.push({
      id: `unverified-printed-label-${id}`,
      passed:
        result.status === "needs_information" &&
        result.products.every((entry) => entry.status === "pending" && entry.rank === null),
    });
  }
  const fixed = parseChargerComparison(
    JSON.parse(
      (
        await request({
          url: lookup.canonicalUrl,
          operation: "compare",
          confirmed: true,
          conditions: { ...conditions, plugPreference: "require_fixed" },
        })
      ).body,
    ),
  );
  safeguards.push({
    id: "required-fixed-never-compensated",
    passed:
      fixed.status === "no_match" && fixed.products.every((entry) => entry.status === "excluded"),
  });
  const before = calls;
  const unsupported = await request({ url: "https://www.elecom.co.jp/products/UNKNOWN.html" });
  safeguards.push({
    id: "unknown-SKU-no-fetch",
    passed: unsupported.statusCode === 422 && calls === before,
  });
} finally {
  globalThis.fetch = realFetch;
}
const summary = {
  decisions: rows.length,
  agrees: rows.filter((row) => row.agrees).length,
  falseCompatible: rows.filter((row) => row.actual === "eligible" && row.expected !== "eligible")
    .length,
  falseExcluded: rows.filter((row) => row.actual === "excluded" && row.expected !== "excluded")
    .length,
  determinate: rows.filter((row) => row.actual !== "pending").length,
  safeguardChecks: safeguards.length,
  safeguardPassed: safeguards.filter((row) => row.passed).length,
};
writeFileSync(
  "docs/charger-quality-results.json",
  `${JSON.stringify({ inputSha256, fetchedAt, realManufacturerRequests: catalogSources.length, independentProductCount: sources.length, scope: gold.scope, summary, safeguards, rows }, null, 2)}\n`,
);
console.log(JSON.stringify(summary));
assert.equal(
  summary.agrees,
  summary.decisions,
  "Gold disagreements; inspect saved report before changing implementation",
);
assert.equal(summary.safeguardPassed, summary.safeguardChecks);
