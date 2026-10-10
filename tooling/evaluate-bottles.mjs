import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { createApiHandler } from "../packages/backend/dist/bootstrap.js";
import { productsSchema, readProduct } from "../packages/backend/dist/comparison/catalog.js";
import { factSchema, rankProducts } from "../packages/backend/dist/comparison/ranking.js";
import { instant, valueOf } from "../packages/backend/dist/comparison/values.js";

const baseline = process.argv.includes("--baseline");
const bytes = readFileSync("docs/bottle-evaluation-cases.json");
const inputSha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(inputSha256, "259acdb44d748ef84a3c9fe54a4bf05f5ef11632deb65d0baa653cb64ba375af");
const gold = JSON.parse(bytes.toString("utf8"));
const observedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(observedAt) + 900_000).toISOString();
const now = instant(observedAt);
assert.equal(now.tag, "ok");
const sources = [];
for (const product of gold.products) {
  const response = await globalThis.fetch(product.url, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const normalized = html.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  assert.ok(normalized.includes(product.model));
  assert.ok(normalized.includes(product.color.replace(/\s+/g, "")));
  for (const [key, value] of product.rows) {
    assert.ok(
      normalized.includes(`${key}${value}`),
      `Reviewed facts changed: ${product.model} ${key}`,
    );
  }
  const featureResponse = await globalThis.fetch(product.featureSource, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(8000),
  });
  assert.equal(featureResponse.status, 200);
  const features = (await featureResponse.text()).replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  assert.ok(
    product.model === "JNL-S501"
      ? features.includes("全パーツ食洗機OK")
      : features.includes("本体もパーツもすべて食洗機で洗える"),
  );
  sources.push({
    model: product.model,
    source: product.url,
    featureSource: product.featureSource,
    observedAt,
  });
}
// These grants apply only to the local, non-network judge probe; they are not production permissions.
const permissions = {
  fetch: { status: "granted", expiresAt },
  display: { status: "granted", expiresAt },
  ai: { status: "granted", expiresAt },
  store: { status: "denied" },
  affiliate: { status: "denied" },
};
function candidate(model, facts, source, color, capacityMl) {
  const evidence = { provider: "thermos-evaluation", source, observedAt };
  const product = productsSchema.parse([
    {
      productId: model,
      evidence,
      permissions,
      identity: {
        manufacturer: "THERMOS",
        model,
        gtin: null,
        variant: {
          status: "confirmed",
          color,
          capacity: { value: capacityMl, unit: "ml" },
          packCount: 1,
        },
      },
    },
  ]);
  assert.equal(product.tag, "ok");
  return {
    product: product.value[0],
    facts: Object.entries(facts).map(([key, value]) => {
      const parsed = factSchema.parse({
        productId: model,
        key,
        status: "confirmed",
        value,
        excerpt: String(value),
        evidence,
        permissions,
      });
      assert.equal(parsed.tag, "ok");
      return parsed.value;
    }),
  };
}
const policy = {
  version: "bottle-requirement-probe-v1",
  category: gold.category,
  mode: "evaluation-only",
  tieMargin: 0,
  minimumConfidence: 0.7,
  criteria: [
    {
      id: "probe",
      weight: 1,
      factKeys: ["category"],
      instructions: "Local eligibility probe, not a quality assessment.",
      levels: ["Excluded", "Included"],
    },
  ],
};
const rows = [];
for (const item of gold.requirementCases) {
  const requirements = item.requirements.map(([key, comparison, value]) => ({
    key,
    comparison,
    value,
  }));
  for (const [index, product] of gold.products.entries()) {
    const target = candidate(
      product.model,
      product.facts,
      product.url,
      product.color,
      product.facts.capacityMl,
    );
    // A known matching synthetic control reveals excluded vs pending in rankProducts' aggregate result.
    // It is never counted as an independently tested real product or a Jev call.
    const control = candidate(
      "synthetic-control",
      {
        category: gold.category,
        ...Object.fromEntries(item.requirements.map(([key, , value]) => [key, value])),
      },
      "https://example.com/local-bottle-control",
      "test",
      500,
    );
    let judgeCalls = 0;
    const judge = (request) => {
      assert.equal(request.state.category, gold.category);
      assert.deepEqual(Object.keys(request.state.facts), ["category"]);
      judgeCalls++;
      return Promise.resolve({
        tag: "ok",
        value: {
          model: "local-probe",
          answers: {
            probe: {
              score: 1,
              confidence: 1,
              legend: { 0: "Excluded", 1: "Included" },
              probabilities: { 0: 0, 1: 1 },
            },
          },
        },
      });
    };
    const result = await rankProducts(
      [target, control],
      requirements,
      [{ id: "probe", status: "confirmed", preference: "Local requirement validation" }],
      policy,
      judge,
      now.value,
    );
    const actual =
      result.tag === "err"
        ? result.error.code === "insufficient_evidence"
          ? "pending"
          : result.error.code
        : result.value.excluded.some((entry) => valueOf(readProduct(entry).id) === product.model)
          ? "excluded"
          : "eligible";
    rows.push({
      id: item.id,
      model: product.model,
      expected: item.expected[index],
      actual,
      agrees: actual === item.expected[index],
      localJudgeCalls: judgeCalls,
    });
    assert.equal(judgeCalls, actual === "eligible" ? 2 : actual === "excluded" ? 1 : 0);
  }
}
const api = createApiHandler(false);
const urlResults = [];
for (const product of gold.products) {
  const response = await api({
    path: "/api/investigate",
    query: "",
    method: "POST",
    body: JSON.stringify({ url: product.url }),
  });
  urlResults.push({
    model: product.model,
    status: response.statusCode,
    body: JSON.parse(response.body),
  });
  assert.equal(
    response.statusCode,
    422,
    "This experiment must not be mistaken for deployed bottle URL support",
  );
}
const summary = {
  independentRealProducts: gold.products.length,
  decisions: rows.length,
  agrees: rows.filter((row) => row.agrees).length,
  falseEligible: rows.filter((row) => row.actual === "eligible" && row.expected !== "eligible")
    .length,
  pending: rows.filter((row) => row.actual === "pending").length,
};
writeFileSync(
  `docs/bottle-requirements-${baseline ? "baseline" : "results"}.json`,
  `${JSON.stringify(
    {
      inputSha256,
      observedAt,
      scope:
        "Reviewed factual inputs into the existing generic requirement core, using a local judge probe. No real Jev calls here. Bottle URL ingestion is unsupported.",
      sources,
      urlResults,
      summary,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(summary));
if (!baseline) assert.equal(summary.agrees, summary.decisions);
