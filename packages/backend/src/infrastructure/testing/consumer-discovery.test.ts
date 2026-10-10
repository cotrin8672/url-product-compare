import assert from "node:assert/strict";
import { test } from "node:test";

import { err, ok } from "../../comparison/algebra.js";
import { createConsumerCategoryDiscovery } from "../../comparison/consumer-discovery.js";
import type {
  ConsumerCategorySelection,
  ConsumerProvider,
} from "../../comparison/consumer-provider.js";
import { applyConsumerChoices, readConsumerInformation } from "../../comparison/consumer.js";
import { instant } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

const now = Date.now();
function at(time = now): Instant {
  const value = instant(new Date(time).toISOString());
  if (value.tag === "err") {
    throw new Error("Invalid fixture clock");
  }
  return value.value;
}
const attributes = [
  { id: 11, label: "総重量" },
  { id: 12, label: "産地（都道府県）" },
  { id: 13, label: "シリーズ名（カナ）" },
];
const genre = { id: "201184", label: "白米", attributes };
const permissions: ConsumerProvider["permissions"] = () => ({
  fetch: true,
  display: true,
  ai: true,
  affiliate: true,
  store: false,
  storeExpiresAt: null,
});

await test("unregistered category selects API attributes once and shares concurrent work", async () => {
  let genreCalls = 0;
  let jevCalls = 0;
  const selection: ConsumerCategorySelection = (label, candidates) => {
    jevCalls += 1;
    assert.equal(label, "白米");
    assert.deepEqual(candidates, attributes.slice(0, 2));
    return Promise.resolve(ok([11, 12]));
  };
  const discover = createConsumerCategoryDiscovery(
    "rakuten",
    () => {
      genreCalls += 1;
      return Promise.resolve(genre);
    },
    selection,
    at,
    permissions,
  );
  const [first, concurrent] = await Promise.all([discover("201184"), discover("201184")]);
  assert.ok(first !== null && concurrent !== null);
  assert.equal(first.aiCalls, 1);
  assert.equal(concurrent.aiCalls, 0);
  assert.equal(first.status, "applied");
  assert.equal(first.definition.id, "rakuten_201184");
  assert.deepEqual(first.definition.mainFields, ["attribute11", "attribute12"]);
  assert.deepEqual(
    first.definition.axes.map((axis) => axis.id),
    ["price", "attribute11", "attribute12"],
  );
  assert.equal(
    first.definition.fields.every((field) => field.kind === "text"),
    true,
  );
  assert.equal((await discover("201184"))?.aiCalls, 0);
  assert.equal(genreCalls, 1);
  assert.equal(jevCalls, 1);
});

await test("category cache expires and unavailable attributes or inference never fabricate main fields", async () => {
  let current = now;
  let calls = 0;
  const discover = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.resolve(genre),
    () => {
      calls += 1;
      return Promise.resolve(ok([11]));
    },
    () => at(current),
    permissions,
  );
  await discover("201184");
  current += 86_400_001;
  assert.equal((await discover("201184"))?.aiCalls, 1);
  assert.equal(calls, 2);
  for (const entries of [[], null]) {
    const empty = createConsumerCategoryDiscovery(
      "rakuten",
      () => Promise.resolve({ ...genre, attributes: entries }),
      () => {
        throw new Error("No inference for empty or invalid dictionaries");
      },
      at,
      permissions,
    );
    const result = await empty("201184");
    assert.ok(result !== null);
    assert.equal(result.status, entries === null ? "unavailable" : "no_attributes");
    assert.deepEqual(result.definition.mainFields, []);
    assert.equal(result.aiCalls, 0);
  }
  let failures = 0;
  const failed = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.resolve(genre),
    () => {
      failures += 1;
      return Promise.resolve(err("unavailable"));
    },
    () => at(current),
    permissions,
  );
  const result = await failed("201184");
  assert.equal(result?.status, "unavailable");
  assert.deepEqual(result.definition.mainFields, []);
  assert.equal((await failed("201184"))?.aiCalls, 0);
  current += 300_001;
  assert.equal((await failed("201184"))?.aiCalls, 1);
  assert.equal(failures, 2);
});

await test("category discovery respects rights and cancellation without caching cancelled selection", async () => {
  let rights = permissions(at());
  const denied = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.resolve(genre),
    () => {
      throw new Error("AI permission denied");
    },
    at,
    () => ({ ...rights, ai: false }),
  );
  assert.equal((await denied("201184"))?.status, "not_configured");
  rights = { ...rights, display: false };
  assert.equal(await denied("201184"), null);
  rights = permissions(at());
  const controller = new AbortController();
  let calls = 0;
  const discover = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.resolve(genre),
    (_label, _attributes, options) => {
      calls += 1;
      if (options?.signal === controller.signal) {
        controller.abort();
      }
      return Promise.resolve(ok([11]));
    },
    at,
    permissions,
  );
  await assert.rejects(discover("201184", { signal: controller.signal }), /abort/i);
  assert.equal((await discover("201184"))?.aiCalls, 1);
  assert.equal(calls, 2);
});

await test("automatic fields retain units, quotes, contradictions and supplied Jev choices", async () => {
  const discover = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.resolve(genre),
    () => Promise.resolve(ok([11, 12])),
    at,
    permissions,
  );
  const category = (await discover("201184"))?.definition;
  assert.ok(category !== undefined);
  const url = "https://item.rakuten.co.jp/shop/rice/";
  const information = readConsumerInformation(
    category,
    "shop:rice",
    url,
    "総重量: 5kg\n産地: 北海道",
  );
  assert.deepEqual(information.specs, { attribute11: "5kg", attribute12: "北海道" });
  assert.equal(
    information.facts.every((fact) => fact.quote.includes(String(fact.value))),
    true,
  );
  assert.equal(information.choices.length, 0);
  const bracketed = readConsumerInformation(
    category,
    "shop:rice",
    url,
    "商品説明【総重量】5kg【産地】北海道【保存方法】高温多湿を避ける",
  );
  assert.deepEqual(bracketed.specs, { attribute11: "5kg", attribute12: "北海道" });
  assert.equal(bracketed.facts[0]?.quote, "【総重量】5kg");
  assert.equal(bracketed.choices.length, 0);
  assert.equal(
    readConsumerInformation(category, "shop:rice", url, `【総重量】${"x".repeat(101)}`).specs[
      "attribute11"
    ],
    null,
  );
  const conflicting = readConsumerInformation(
    category,
    "shop:rice",
    url,
    "総重量: 5kg\n総重量: 10kg",
  );
  assert.equal(conflicting.specs["attribute11"], null);
  assert.ok(conflicting.conflicts.includes("attribute11"));
  const info = readConsumerInformation(category, "shop:rice", url, "内容量: 5kg");
  assert.equal(info.specs["attribute11"], null);
  assert.equal(info.choices[0]?.options[0]?.fact.value, "5kg");
  const applied = applyConsumerChoices(info, { "shop:rice_attribute11": "option_0" });
  assert.equal(applied.specs["attribute11"], "5kg");
  assert.equal(applied.facts[0]?.quote, "内容量: 5kg");
  assert.equal(applied.facts[0].method, "jev_choice");
  assert.equal(
    applyConsumerChoices(info, { "shop:rice_attribute11": "invented" }).specs["attribute11"],
    null,
  );
});
