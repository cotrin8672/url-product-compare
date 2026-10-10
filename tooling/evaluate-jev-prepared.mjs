import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { productsSchema } from "../packages/backend/dist/comparison/catalog.js";
import {
  factSchema,
  preferencesSchema,
  rankProducts,
} from "../packages/backend/dist/comparison/ranking.js";
import { instant } from "../packages/backend/dist/comparison/values.js";
import { createJevJudge } from "../packages/backend/dist/providers/jev/index.js";

const replay = process.argv.includes("--replay");
const positional = process.argv.slice(2).filter((argument) => argument !== "--replay");
const inputPath = positional[0] ?? "docs/jev-prepared-cases.json";
const livePath = positional[1] ?? "docs/jev-prepared-results.json";
const outputPath = replay ? livePath.replace(/(?:-results)?\.json$/, "-replay.json") : livePath;
assert.ok(inputPath !== outputPath && (!replay || livePath !== outputPath));
const source = readFileSync(inputPath, "utf8");
const input = JSON.parse(source);
const inputSha256 = createHash("sha256").update(source).digest("hex");
assert.equal(input.version, "jev-prepared-v1");
assert.equal(input.model, "jev-1.13.0");
assert.ok(input.cases.length > 0 && input.cases.length <= 30);
assert.equal(new Set(input.cases.map((item) => item.id)).size, input.cases.length);
const baseline = replay ? JSON.parse(readFileSync(livePath, "utf8")) : null;
if (replay) assert.equal(baseline.inputSha256, inputSha256);
if (!replay && existsSync(".env")) process.loadEnvFile(".env");
const apiKey = replay ? "offline-replay" : process.env["TYPESAFE_API_KEY"];
assert.ok(typeof apiKey === "string" && apiKey.length > 0, "TYPESAFE_API_KEY is required");

// Review only the new source in memory. Do not store or send manufacturer HTML.
if (!replay && input.products.some((item) => item.model === "SM-TA48")) {
  const response = await globalThis.fetch("https://www.zojirushi.co.jp/syohin/bottle/smta/", {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true);
  const html = await response.text();
  assert.ok(html.length < 512_000);
  const product = input.products.find((item) => item.model === "SM-TA48");
  assert.ok(product !== undefined);
  for (const claim of product.reviewedClaims)
    assert.ok(html.includes(claim), `Source changed: ${claim}`);
}

const rows = [];
let totalCalls = 0;
for (const item of input.cases) {
  const product = input.products.find((entry) => entry.model === item.model);
  assert.ok(product !== undefined);
  const observedAt = new Date().toISOString();
  const now = instant(observedAt);
  assert.equal(now.tag, "ok");
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const rights = {
    fetch: { status: "granted", expiresAt },
    display: { status: "granted", expiresAt },
    store: { status: "denied" },
    ai: { status: "granted", expiresAt },
    affiliate: { status: "denied" },
  };
  const evidence = { provider: "evaluation", source: product.source, observedAt };
  const identity = productsSchema.parse([
    {
      productId: product.model,
      evidence,
      permissions: rights,
      identity: {
        manufacturer: product.manufacturer,
        model: product.model,
        gtin: null,
        variant: { status: "confirmed", color: product.color, capacity: null, packCount: 1 },
      },
    },
  ]);
  assert.equal(identity.tag, "ok");
  const facts = [...new Set(input.policy.criteria.flatMap((entry) => entry.factKeys))].map(
    (key) => {
      const value = product.facts[key];
      const confirmed = value !== undefined && !item.unverifiedKeys.includes(key);
      const parsed = factSchema.parse({
        productId: product.model,
        key,
        status: confirmed ? "confirmed" : "unknown",
        value: confirmed ? value : null,
        excerpt: confirmed ? value : null,
        evidence: { ...evidence, source: product.factSources?.[key] ?? product.source },
        permissions: rights,
      });
      assert.equal(parsed.tag, "ok");
      return parsed.value;
    },
  );
  const conditions = preferencesSchema.parse(
    input.policy.criteria.map(
      ({ id }) =>
        item.preferences.find((entry) => entry.id === id) ?? { id, status: "not_applicable" },
    ),
  );
  assert.equal(conditions.tag, "ok");
  const transport = [];
  const before = totalCalls;
  const remaining = replay ? [...baseline.rows.find((row) => row.id === item.id).transport] : [];
  const judge = createJevJudge(apiKey, input.model, async (_url, options) => {
    assert.ok(typeof options.body === "string");
    const request = JSON.parse(options.body);
    assert.equal(Object.keys(request.questions).length, 1);
    const id = Object.keys(request.questions)[0];
    const criterion = input.policy.criteria.find((entry) => entry.id === id);
    assert.ok(criterion !== undefined);
    assert.deepEqual(Object.keys(request.state.facts), criterion.factKeys);
    assert.deepEqual(Object.keys(request.state.excerpts), criterion.factKeys);
    assert.equal(item.preferences.find((entry) => entry.id === id)?.status, "confirmed");
    totalCalls++;
    assert.ok(totalCalls <= 90, "Bound live spending");
    const entry = { request };
    transport.push(entry);
    if (replay) {
      const index = remaining.findIndex((row) => JSON.stringify(row.request) === options.body);
      assert.ok(index >= 0, "Replay must match the complete prepared request");
      const [saved] = remaining.splice(index, 1);
      Object.assign(entry, saved);
      return new globalThis.Response(JSON.stringify(saved.response), { status: saved.status });
    }
    const response = await globalThis.fetch("https://api.typesafe.ai/v1/systemone", options);
    entry.status = response.status;
    if (response.ok) {
      const body = await response.clone().json();
      entry.response = { model: body.model, answers: body.answers, usage: body.usage };
    }
    return response;
  });
  const result = await rankProducts(
    [{ product: identity.value[0], facts }],
    [],
    conditions.value,
    input.policy,
    judge,
    now.value,
  );
  const actualError = result.tag === "err" ? result.error.code : null;
  const axes =
    result.tag === "ok"
      ? result.value.ranked[0].criteria.map((axis) => ({
          id: axis.id,
          score: axis.score,
          confidence: axis.confidence,
          probabilities: axis.probabilities,
          expected: item.expected[axis.id],
          decision: Math.round(axis.score),
          agrees: Math.round(axis.score) === item.expected[axis.id],
        }))
      : [];
  const agrees =
    actualError === item.expectedError &&
    (actualError !== null ||
      (axes.length === Object.keys(item.expected).length && axes.every((axis) => axis.agrees)));
  rows.push({
    id: item.id,
    group: item.group,
    model: item.model,
    expectedError: item.expectedError,
    actualError,
    agrees,
    calls: totalCalls - before,
    axes,
    transport,
  });
  if (item.expectedError !== null)
    assert.equal(totalCalls, before, "Unresolved input must not call Jev");
  if (replay) assert.equal(remaining.length, 0);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        evaluatedAt: new Date().toISOString(),
        inputSha256,
        model: input.model,
        note: input.note,
        replay,
        totalCalls,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  if (rows.length % 5 === 0 || rows.length === input.cases.length) {
    console.log(
      JSON.stringify({ completed: rows.length, total: input.cases.length, calls: totalCalls }),
    );
  }
  if (["jev_unavailable", "jev_unauthorized", "jev_payment_required"].includes(actualError)) break;
}
console.log(
  JSON.stringify({
    cases: rows.length,
    agrees: rows.filter((row) => row.agrees).length,
    calls: totalCalls,
    disagreements: rows.filter((row) => !row.agrees).map((row) => row.id),
  }),
);
assert.equal(rows.length, input.cases.length);
assert.ok(
  rows.every((row) => row.agrees),
  "Inspect retained errors; never relabel to make the evaluation pass",
);
