import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConsumerCatalog } from "../../comparison/consumer-catalog.js";
import type { ConsumerCategoryDefinition } from "../../comparison/consumer-catalog.js";
import type { ConsumerAssessments } from "../../comparison/consumer-scoring.js";
import { consumerValueSpans } from "../../comparison/consumer-spans.js";
import {
  applyConsumerChoices,
  compareConsumerListings,
  readConsumerInformation,
} from "../../comparison/consumer.js";

const category: ConsumerCategoryDefinition = {
  id: "rakuten_303017",
  label: "コーヒー",
  description: "コーヒーを比較",
  mainFields: ["weight", "count"],
  fields: [
    {
      id: "weight",
      label: "単品重量",
      unit: "",
      kind: "text",
      filter: null,
      minimum: 0,
      maximum: 0,
      presets: [],
      extraction: { kind: "attribute" },
    },
    {
      id: "count",
      label: "入数",
      unit: "",
      kind: "text",
      filter: null,
      minimum: 0,
      maximum: 0,
      presets: [],
      extraction: { kind: "attribute" },
    },
  ],
  axes: [
    { id: "price", label: "価格", lowerIsBetter: true, weight: 1 },
    { id: "weight", label: "単品重量", lowerIsBetter: false, weight: 1, method: "jev" },
  ],
};
const model = "jev-1.13.0";
const url = "https://item.rakuten.co.jp/shop/source/";
function listing(
  id: string,
  text: string,
  price = 1000,
): Readonly<{
  listingId: string;
  tax: "included";
  availability: "available";
  condition: "new";
  price: Readonly<{ minimum: number; maximum: number }>;
  consumerInformation: ReturnType<typeof readConsumerInformation>;
}> {
  return {
    listingId: id,
    tax: "included",
    availability: "available",
    condition: "new",
    price: { minimum: price, maximum: price },
    consumerInformation: readConsumerInformation(category, id, url, text),
  };
}

await test("automatic categories exclude unknown, used and refurbished listings even with legacy opt-in", () => {
  for (const condition of ["unknown", "used", "refurbished"] satisfies ReadonlyArray<
    "unknown" | "used" | "refurbished"
  >) {
    const compared = compareConsumerListings(
      [{ ...listing("source", "単品重量: 200g"), condition }],
      { ...category, allowUnknownCondition: true },
      {},
      "recommendation",
    );
    assert.equal(compared.status, "no_match");
    const product = compared.products[0];
    assert.ok(product !== undefined);
    assert.equal(product.status, "excluded");
    assert.equal(product.rank, null);
  }
});

await test("automatic values include title quantities and their parts, with literal evidence only", () => {
  assert.doesNotThrow(() => buildConsumerCatalog([category]));
  assert.throws(() =>
    buildConsumerCatalog([
      {
        ...category,
        axes: category.axes.map((axis) => ({
          id: axis.id,
          label: axis.label,
          weight: axis.weight,
          lowerIsBetter: axis.lowerIsBetter,
        })),
      },
    ]),
  );
  const text = "徳用コーヒー 200g×5袋\n【商品説明】フリーズドライです。";
  const information = readConsumerInformation(category, "source", url, text);
  assert.deepEqual(information.specs, { weight: null, count: null });
  for (const choice of information.choices) {
    assert.equal(choice.category, category.label);
    assert.ok(choice.options.length <= 8);
    for (const option of choice.options) {
      assert.ok(text.includes(option.fact.quote));
      assert.ok(option.fact.quote.includes(String(option.fact.value)));
    }
    assert.ok(choice.options.some((option) => option.fact.value === "200g"));
    assert.ok(choice.options.some((option) => option.fact.value === "5袋"));
  }
  const selected = Object.fromEntries(
    information.choices.flatMap((choice) => {
      const option = choice.options.find(
        (entry) => entry.fact.value === (choice.field === "weight" ? "200g" : "5袋"),
      );
      return option === undefined ? [] : [[choice.id, option.id]];
    }),
  );
  const applied = applyConsumerChoices(information, selected);
  assert.deepEqual(applied.specs, { weight: "200g", count: "5袋" });
  assert.equal(
    applied.facts.every((fact) => fact.method === "jev_choice"),
    true,
  );
  assert.deepEqual(
    applyConsumerChoices(information, { source_weight: "invented" }).specs,
    information.specs,
  );
  assert.equal(
    readConsumerInformation(category, "source", url, "単品重量: 未確認").specs["weight"],
    null,
  );
  const quantities = consumerValueSpans("内容量: 200gx5袋セット、50本入り、3セット、解像度1920px");
  for (const value of ["200g", "5袋", "50本", "3セット", "1920px"]) {
    assert.ok(
      quantities.some((span) => span.value === value),
      value,
    );
  }
  assert.equal(
    quantities.some(
      (span) => span.value === "内容量" || span.value === "1920p" || span.value === "50本入",
    ),
    false,
  );
});

await test("automatic 100-point totals share one basis and do not impute missing products", () => {
  const products = [
    listing("a", "単品重量: 200g"),
    listing("b", "単品重量: 200g"),
    listing("c", "単品重量: 100g"),
    listing("missing", "記載なし"),
  ];
  const assessments: ConsumerAssessments = {
    a: { weight: { model, index: 3, confidence: 0.9 } },
    b: { weight: { model, index: 3, confidence: 0.9 } },
    c: { weight: { model, index: 1, confidence: 0.9 } },
    missing: { weight: { model, index: 4, confidence: 1 } },
  };
  const compared = compareConsumerListings(products, category, {}, "recommendation", assessments);
  assert.deepEqual(compared.scoreBasis, ["price", "weight"]);
  assert.equal(compared.products.find((product) => product.listingId === "a")?.axes[1]?.score, 75);
  assert.equal(compared.products.find((product) => product.listingId === "c")?.axes[1]?.score, 25);
  assert.equal(
    compared.products.find((product) => product.listingId === "missing")?.axes[1]?.score,
    null,
  );
  assert.equal(
    compared.products.find((product) => product.listingId === "missing")?.recommendationPercent,
    null,
  );
  assert.equal(
    compared.products.find((product) => product.listingId === "a")?.recommendationPercent,
    88,
  );
  assert.equal(compared.status, "needs_information");
  assert.ok(compared.products.every((product) => product.rank === null));
  const allKnown = compareConsumerListings(
    products.slice(0, 3),
    category,
    {},
    "recommendation",
    assessments,
  );
  assert.equal(allKnown.status, "ranked");
  assert.deepEqual(
    allKnown.products.map((product) => product.rank),
    [1, 1, 3],
  );
});

await test("invalid and uncertain Jev assessments never become numbers, zero remains a valid score", () => {
  const products = [listing("a", "単品重量: 200g"), listing("b", "単品重量: 100g")];
  for (const assessment of [
    { model: "other", index: 2, confidence: 1 },
    { model, index: Number.NaN, confidence: 1 },
    { model, index: 5, confidence: 1 },
    { model, index: 2, confidence: 0.59 },
  ]) {
    const compared = compareConsumerListings(products, category, {}, "recommendation", {
      a: { weight: assessment },
    });
    assert.equal(compared.products[0]?.axes[1]?.score, null);
    assert.deepEqual(compared.scoreBasis, []);
  }
  const compared = compareConsumerListings(products, category, {}, "recommendation", {
    a: { weight: { model, index: 0, confidence: 0.9 } },
    b: { weight: { model, index: 2, confidence: 0.59 } },
  });
  assert.equal(compared.products[0]?.axes[1]?.score, 0);
  assert.equal(compared.products[1]?.axes[1]?.score, null);
  assert.deepEqual(compared.scoreBasis, []);
  assert.ok(compared.products.every((product) => product.recommendationPercent === null));
});
