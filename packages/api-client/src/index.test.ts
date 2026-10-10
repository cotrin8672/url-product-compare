import assert from "node:assert/strict";
import { test } from "node:test";

import { parseComparisonJob } from "./consumer.js";
import {
  cancelConsumerComparisonJob,
  clearComparisonSession,
  compareChargers,
  compareConsumerProducts,
  consumerCategories,
  compareMonitors,
  compareProducts,
  fetchProductCatalog,
  createComparisonOperation,
  createComparisonRequestScope,
  comparisonDisplayExpiresAt,
  comparisonDetailLayout,
  detectProductCategory,
  parseConsumerComparison,
  parseDetectResult,
  readActiveComparisonCategory,
  readComparisonSession,
  writeComparisonSession,
  waitForComparisonPoll,
  parseCandidateSearch,
  parseChargerComparison,
  parseChargerUse,
  parseInvestigation,
  parseProductCatalog,
  comparisonStageLabel,
  comparisonAxisWeightPercent,
  parsePublicCompareRoute,
  phaseFromJobState,
  pollConsumerComparisonJob,
  readConsumerComparisonJob,
  resetConsumerCatalogCache,
  shouldPollJob,
  startConsumerComparisonJob,
} from "./index.js";
import type { ConsumerComparison, MonitorConditions, ProductCatalog } from "./index.js";

await test("comparison details hide wholly unknown fields, retain zero and false, and keep six shared primary axes without changing data", () => {
  const fixture = genericFixture();
  const base = fixture.catalog.categories[0];
  assert.ok(base !== undefined);
  const axes = Array.from({ length: 9 }, (_, index) => ({
    id: `metric${index}`,
    label: `評価${index}`,
    lowerIsBetter: false,
    weight: index + 1,
  }));
  const category = {
    ...base,
    axes: [{ id: "price", label: "価格", lowerIsBetter: true, weight: 1 }, ...axes],
    fields: [
      ...base.fields,
      ...axes.map(
        (axis) =>
          ({
            id: axis.id,
            label: axis.label,
            unit: "",
            kind: "number",
            filter: null,
            minimum: 1,
            maximum: 100,
            presets: [],
          }) satisfies ProductCatalog["categories"][number]["fields"][number],
      ),
      {
        id: "cpu",
        label: "CPU",
        unit: "",
        kind: "text",
        filter: null,
        minimum: 0,
        maximum: 0,
        presets: [],
      },
      {
        id: "lan",
        label: "有線LAN",
        unit: "",
        kind: "boolean",
        filter: null,
        minimum: 0,
        maximum: 0,
        presets: [],
      },
      {
        id: "os",
        label: "OS",
        unit: "",
        kind: "text",
        filter: null,
        minimum: 0,
        maximum: 0,
        presets: [],
      },
    ],
  } satisfies ProductCatalog["categories"][number];
  const checked = parseProductCatalog({
    tag: "ok",
    value: { ...fixture.catalog, categories: [category] },
  });
  assert.equal(checked.categories[0]?.axes.length, 10);
  const products = [
    {
      axes: axes.map((axis) => ({ id: axis.id, label: axis.label, score: 1 })),
      consumerInformation: {
        specs: Object.fromEntries(
          category.fields.map((field) => [
            field.id,
            field.kind === "text" ? "取得済み" : field.kind === "boolean" ? true : 1,
          ]),
        ),
        facts: [],
        conflicts: [],
      },
    },
  ] satisfies ReadonlyArray<
    Pick<ConsumerComparison["products"][number], "axes" | "consumerInformation">
  >;
  const original = JSON.stringify(category);
  const layout = comparisonDetailLayout(category, products);
  assert.deepEqual(
    layout.primaryAxes.map((axis) => axis.id),
    axes.slice(0, 6).map((axis) => axis.id),
  );
  assert.deepEqual(
    layout.detailAxes.map((axis) => axis.id),
    axes.slice(6).map((axis) => axis.id),
  );
  assert.deepEqual(
    layout.specificationFields.map((field) => field.id),
    ["cpu", "lan", "os"],
  );
  assert.equal(JSON.stringify(category), original);
  assert.deepEqual(comparisonDetailLayout(base, products).detailAxes, []);
  assert.deepEqual(comparisonDetailLayout({ ...base, axes: [] }, products).primaryAxes, []);
  const partialProducts = [
    {
      axes: axes.map((axis, index) => ({
        id: axis.id,
        label: axis.label,
        score: index === 1 || index === 7 ? null : index,
      })),
      consumerInformation: {
        specs: {
          metric0: 0,
          metric1: null,
          metric2: 2,
          metric3: 3,
          metric4: 4,
          metric5: 5,
          metric6: 6,
          metric8: 8,
          cpu: null,
          lan: false,
          os: null,
        },
        facts: [],
        conflicts: [],
      },
    },
    {
      axes: axes.map((axis) => ({ id: axis.id, label: axis.label, score: null })),
      consumerInformation: {
        specs: { metric0: null, metric1: null, cpu: "取得済みCPU", lan: null, os: null },
        facts: [],
        conflicts: [],
      },
    },
  ] satisfies ReadonlyArray<
    Pick<ConsumerComparison["products"][number], "axes" | "consumerInformation">
  >;
  const originalProducts = JSON.stringify(partialProducts);
  const partialLayout = comparisonDetailLayout(category, partialProducts);
  assert.deepEqual(
    partialLayout.primaryAxes.map((axis) => axis.id),
    ["metric0", "metric2", "metric3", "metric4", "metric5", "metric6"],
  );
  assert.deepEqual(
    partialLayout.detailAxes.map((axis) => axis.id),
    ["metric8"],
  );
  assert.deepEqual(
    partialLayout.specificationFields.map((field) => field.id),
    ["cpu", "lan"],
  );
  assert.equal(JSON.stringify(category), original);
  assert.equal(JSON.stringify(partialProducts), originalProducts);
  const unscoredLayout = comparisonDetailLayout(
    category,
    products.map((product) => ({
      ...product,
      axes: product.axes.map((axis) => ({ ...axis, score: null })),
    })),
  );
  assert.deepEqual(unscoredLayout.primaryAxes, []);
  assert.deepEqual(unscoredLayout.detailAxes, []);
  assert.deepEqual(unscoredLayout.specificationFields, layout.specificationFields);
  const emptyLayout = { primaryAxes: [], detailAxes: [], specificationFields: [] };
  assert.deepEqual(comparisonDetailLayout(category, []), emptyLayout);
  assert.deepEqual(
    comparisonDetailLayout(category, [
      { axes: [], consumerInformation: { specs: {}, facts: [], conflicts: [] } },
    ]),
    emptyLayout,
  );
});

await test("expanded comparison catalogs accept 32 axes with six primary slots and reject oversized or duplicate axes", () => {
  const fixture = genericFixture();
  const base = fixture.catalog.categories[0];
  assert.ok(base !== undefined);
  const fields = Array.from(
    { length: 32 },
    (_, index) =>
      ({
        id: `metric${index}`,
        label: `評価${index}`,
        unit: "",
        kind: "number",
        filter: null,
        minimum: 1,
        maximum: 100,
        presets: [],
      }) satisfies ProductCatalog["categories"][number]["fields"][number],
  );
  const axes = fields.map((field) => ({
    id: field.id,
    label: field.label,
    lowerIsBetter: false,
    weight: 1,
  }));
  const category = {
    ...base,
    fields,
    axes,
    mainFields: [],
  } satisfies ProductCatalog["categories"][number];
  const parse = (entry: typeof category): ProductCatalog =>
    parseProductCatalog({ tag: "ok", value: { ...fixture.catalog, categories: [entry] } });
  const parsed = parse(category).categories[0];
  assert.ok(parsed !== undefined);
  const products = [
    {
      axes: axes.map((axis) => ({ id: axis.id, label: axis.label, score: 1 })),
      consumerInformation: {
        specs: Object.fromEntries(fields.map((field) => [field.id, 1])),
        facts: [],
        conflicts: [],
      },
    },
  ];
  assert.equal(comparisonDetailLayout(parsed, products).primaryAxes.length, 6);
  assert.equal(comparisonDetailLayout(parsed, products).detailAxes.length, 26);
  assert.throws(() =>
    parse({
      ...category,
      axes: [...axes, { id: "extra", label: "追加", lowerIsBetter: false, weight: 1 }],
    }),
  );
  assert.throws(() => parse({ ...category, axes: [...axes.slice(1), ...axes.slice(1, 2)] }));
});

function genericFixture() {
  const catalog = {
    categories: [
      {
        id: "air_purifier",
        label: "空気清浄機",
        description: "新カテゴリの比較",
        fields: [
          {
            id: "cleanAirM3H",
            label: "清浄能力",
            unit: "m³/h",
            kind: "number",
            filter: "min",
            minimum: 1,
            maximum: 2000,
            presets: [100, 200],
          },
          {
            id: "noiseDb",
            label: "音量",
            unit: "dB",
            kind: "number",
            filter: "max",
            minimum: 1,
            maximum: 120,
            presets: [40, 50],
          },
        ],
        mainFields: ["cleanAirM3H", "noiseDb"],
        axes: [
          { id: "price", label: "価格", lowerIsBetter: true, weight: 2 },
          { id: "cleanAirM3H", label: "清浄能力", lowerIsBetter: false, weight: 3 },
          { id: "noiseDb", label: "静かさ", lowerIsBetter: true, weight: 1 },
        ],
      },
    ],
    providers: [
      {
        id: "different",
        label: "別ショップ",
        urlHosts: ["shop.different.test"],
        affiliateHosts: ["partner.different.test"],
      },
    ],
  } satisfies ProductCatalog;
  const category = catalog.categories[0];
  assert.ok(category !== undefined);
  const listing = (index: number) => {
    const canonicalUrl = `https://shop.different.test/product/${index}`;
    const specs = { cleanAirM3H: index === 1 ? 100 : 200, noiseDb: index === 1 ? 40 : 50 };
    return {
      provider: "different",
      listingId: `sku-${index}`,
      title: `清浄機 ${index}`,
      shopName: "別ショップ",
      condition: "new",
      canonicalUrl,
      affiliateUrl: `https://partner.different.test/link/${index}?partner=sample`,
      imageUrl: `https://cdn.different.test/${index}.webp`,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      price: {
        minimum: index === 1 ? 2000 : 1000,
        maximum: index === 1 ? 2000 : 1000,
        currency: "JPY",
      },
      tax: "included",
      shipping: "excluded",
      availability: "available",
      identityVerified: true,
      consumerInformation: {
        specs,
        facts: Object.entries(specs).map(([field, value]) => ({
          field,
          value,
          quote: `${value}`,
          sourceUrl: canonicalUrl,
          source: "different_product_api",
          method: "pattern",
        })),
        conflicts: [],
      },
    };
  };
  const source = listing(1);
  const candidate = listing(2);
  const comparison = {
    category: category.id,
    categoryDefinition: category,
    providerDefinitions: catalog.providers,
    conditions: { cleanAirM3H: 100 },
    sort: "recommendation",
    source,
    status: "ranked",
    storageExpiresAt: new Date(Date.now() + 720_000).toISOString(),
    products: [
      {
        ...source,
        status: "eligible",
        rank: 2,
        recommendationPercent: 58,
        axes: category.axes.map((axis, index) => ({
          id: axis.id,
          label: axis.label,
          score: [50, 50, 100][index],
        })),
        reasons: [],
      },
      {
        ...candidate,
        status: "eligible",
        rank: 1,
        recommendationPercent: 97,
        axes: category.axes.map((axis, index) => ({
          id: axis.id,
          label: axis.label,
          score: [100, 100, 80][index],
        })),
        reasons: [],
      },
    ],
    aiCalls: { openai: 0, jev: 0 },
    extractionStatus: "not_needed",
    search: {
      pages: 1,
      examined: 2,
      duplicates: 0,
      excluded: 0,
      pending: 0,
      stopReason: "exhausted",
    },
  };
  return { catalog, category, source, candidate, comparison };
}

await test("consumer client validates zero counts without converting them to missing scores", () => {
  const fixture = genericFixture();
  const axis = { id: "cleanAirM3H", label: "USB-C", lowerIsBetter: false, weight: 1 };
  const category = {
    ...fixture.category,
    fields: fixture.category.fields.map((field) =>
      field.id === axis.id ? { ...field, minimum: 0 } : field,
    ),
    axes: [axis],
  };
  const catalog = parseProductCatalog({
    tag: "ok",
    value: { ...fixture.catalog, categories: [category] },
  });
  for (const counts of [
    [0, 4],
    [0, 0],
  ]) {
    const products = fixture.comparison.products.map((product, index) => {
      const count = counts[index];
      assert.ok(count !== undefined);
      const score = count === 0 && counts.some((entry) => entry > 0) ? 0 : 100;
      return {
        ...product,
        consumerInformation: {
          ...product.consumerInformation,
          specs: { ...product.consumerInformation.specs, [axis.id]: count },
          facts: product.consumerInformation.facts.map((fact) =>
            fact.field === axis.id ? { ...fact, value: count, quote: String(count) } : fact,
          ),
        },
        axes: [{ ...axis, score }],
        rank: 1 + counts.filter((entry) => entry > count).length,
        recommendationPercent: score,
      };
    });
    const source = products[0];
    assert.ok(source !== undefined);
    const input = {
      tag: "ok",
      value: {
        ...fixture.comparison,
        categoryDefinition: category,
        conditions: {},
        source,
        products,
      },
    };
    const parsed = parseConsumerComparison(input, catalog);
    assert.equal(parsed.products[0]?.axes[0]?.score, counts.some((count) => count > 0) ? 0 : 100);
    assert.throws(() =>
      parseConsumerComparison(
        {
          tag: "ok",
          value: {
            ...input.value,
            products: products.map((product) => ({ ...product, axes: [{ ...axis, score: null }] })),
          },
        },
        catalog,
      ),
    );
  }
});

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  if (complete === undefined) {
    throw new Error("Deferred promise did not initialize");
  }
  return { promise, resolve: complete };
}

function testCatalog(): ProductCatalog {
  const field = (
    id: string,
    label: string,
    unit: string,
    kind: "number" | "text" | "boolean",
    filter: "min" | "max" | "required" | null,
    minimum: number,
    maximum: number,
  ) =>
    Object.freeze({ id, label, unit, kind, filter, minimum, maximum, presets: Object.freeze([]) });
  const laptop = Object.freeze({
    id: "laptop",
    label: "ノートPC",
    description: "仕事、学習、持ち運びに",
    mainFields: Object.freeze(["ramGb", "storageGb", "screenInches", "weightG"]),
    axes: Object.freeze([
      Object.freeze({ id: "price", label: "価格", lowerIsBetter: true, weight: 1 }),
      Object.freeze({ id: "ramGb", label: "メモリ", lowerIsBetter: false, weight: 1 }),
      Object.freeze({ id: "storageGb", label: "保存容量", lowerIsBetter: false, weight: 1 }),
      Object.freeze({ id: "weightG", label: "軽さ", lowerIsBetter: true, weight: 1 }),
    ]),
    fields: Object.freeze([
      field("cpu", "CPU", "", "text", null, 0, 0),
      field("os", "OS", "", "text", null, 0, 0),
      field("ramGb", "メモリ", "GB", "number", "min", 1, 512),
      field("storageGb", "保存容量", "GB", "number", "min", 1, 32768),
      field("screenInches", "画面", "インチ", "number", "min", 3, 120),
      field("widthPx", "横", "px", "number", "min", 320, 16384),
      field("heightPx", "縦", "px", "number", null, 240, 8640),
      field("weightG", "重さ", "g", "number", "max", 1, 100000),
      field("batteryHours", "バッテリー", "時間", "number", null, 0, 100),
    ]),
  });
  const providers = Object.freeze([
    Object.freeze({
      id: "rakuten",
      label: "楽天市場",
      urlHosts: Object.freeze(["item.rakuten.co.jp"]),
      affiliateHosts: Object.freeze(["hb.afl.rakuten.co.jp"]),
    }),
    Object.freeze({
      id: "example",
      label: "Example",
      urlHosts: Object.freeze(["shop.example.test"]),
      affiliateHosts: Object.freeze(["aff.example.test"]),
    }),
  ]);
  return Object.freeze({ categories: Object.freeze([laptop]), providers });
}

await test("consumer client validates category fields, source, evidence, eligibility, duplicate identities and price ties", async (context) => {
  resetConsumerCatalogCache();
  const catalog = testCatalog();
  const category = consumerCategories(catalog).find((entry) => entry.id === "laptop");
  assert.ok(category !== undefined);
  const listing = (index: number) => {
    const canonicalUrl = `https://item.rakuten.co.jp/shop/consumer-${index}/`;
    return {
      mode: "live",
      notice: "API listing",
      provider: "rakuten",
      condition: "new",
      listingId: `shop:consumer-${index}`,
      productId: null,
      matchMethod: null,
      title: `Laptop MODEL-${index}`,
      shopName: "Example shop",
      canonicalUrl,
      affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/11111111.22222222.33333333.44444444/?${new URLSearchParams({ pc: canonicalUrl, m: canonicalUrl }).toString()}`,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      price: {
        minimum: index === 0 ? 80000 : 30000,
        maximum: index === 0 ? 80000 : 30000,
        currency: "JPY",
      },
      tax: "included",
      shipping: "excluded",
      availability: "available",
      identityVerified: true,
      rakutenProductId: String(index + 1).repeat(32),
      specifications: {
        model: `MODEL-${index}`,
        brand: null,
        gtin: index === 0 ? "4549550281836" : "4549550281829",
        color: null,
      },
      consumerInformation: {
        specs: Object.fromEntries(
          category.fields.map((field) => [field.id, field.id === "ramGb" ? 16 : null]),
        ),
        facts: [
          {
            field: "ramGb",
            value: 16,
            quote: "メモリ: 16GB",
            sourceUrl: canonicalUrl,
            method: "pattern",
            source: "rakuten_item_api",
          },
        ],
        conflicts: [],
      },
    };
  };
  const source = listing(0);
  const candidate = listing(1);
  const value = {
    category: "laptop",
    categoryDefinition: category,
    providerDefinitions: catalog.providers,
    conditions: { ramGb: 16 },
    sort: "price",
    source,
    status: "ranked",
    products: [
      {
        ...source,
        status: "eligible",
        reasons: [],
        rank: 2,
        recommendationPercent: 69,
        axes: [
          { id: "price", label: "価格", score: 38 },
          { id: "ramGb", label: "メモリ", score: 100 },
          { id: "storageGb", label: "保存容量", score: null },
          { id: "weightG", label: "軽さ", score: null },
        ],
      },
      {
        ...candidate,
        status: "eligible",
        reasons: [],
        rank: 1,
        recommendationPercent: 100,
        axes: [
          { id: "price", label: "価格", score: 100 },
          { id: "ramGb", label: "メモリ", score: 100 },
          { id: "storageGb", label: "保存容量", score: null },
          { id: "weightG", label: "軽さ", score: null },
        ],
      },
    ],
    aiCalls: { openai: 0, jev: 0 },
    extractionStatus: "not_needed",
    search: {
      pages: 1,
      examined: 1,
      duplicates: 0,
      excluded: 0,
      pending: 0,
      stopReason: "exhausted",
    },
  };
  let upstream: unknown = { tag: "ok", value };
  let calls = 0;
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    calls += 1;
    if (path === "/api/catalog") {
      return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
    }
    assert.equal(path, "/api/compare");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    assert.ok(
      typeof body === "object" && body !== null && "category" in body && "conditions" in body,
    );
    assert.equal(body.category, "laptop");
    assert.deepEqual(body.conditions, { ramGb: 16 });
    return Promise.resolve(Response.json(upstream));
  });
  assert.equal(
    (await compareConsumerProducts(source.canonicalUrl, "laptop", { ramGb: 16 }, "price")).products
      .length,
    2,
  );
  upstream = {
    tag: "ok",
    value: {
      ...value,
      source: { ...source, identityVerified: false },
      products: value.products.map((product) => ({ ...product, identityVerified: false })),
    },
  };
  const withoutCatalogIdentity = await compareConsumerProducts(
    source.canonicalUrl,
    "laptop",
    { ramGb: 16 },
    "price",
  );
  assert.deepEqual(
    withoutCatalogIdentity.products.map((product) => [
      product.identityVerified,
      product.recommendationPercent,
    ]),
    [
      [false, 69],
      [false, 100],
    ],
  );
  const badCandidate = (patch: Readonly<Record<string, unknown>>) => ({
    products: [value.products[0], { ...value.products[1], ...patch }],
  });
  for (const patch of [
    { category: "television" },
    { conditions: { ramGb: 8 } },
    { products: [] },
    { products: [value.products[0], value.products[0]] },
    {
      source: {
        ...source,
        consumerInformation: {
          ...source.consumerInformation,
          specs: { ...source.consumerInformation.specs, ramGb: 32 },
        },
      },
    },
    { aiCalls: { openai: 1, jev: 0 } },
    { aiCalls: { openai: 0, jev: 2 } },
    badCandidate({ rank: 2 }),
    badCandidate({ recommendationPercent: 99 }),
    badCandidate({ axes: [] }),
    badCandidate({ axes: value.products[1]?.axes.map((axis) => ({ ...axis, score: 100 })) }),
    badCandidate({ status: "pending", rank: null }),
    badCandidate({ availability: "unavailable" }),
    badCandidate({ tax: "excluded" }),
    badCandidate({ price: { ...candidate.price, maximum: 40000 } }),
    badCandidate({
      consumerInformation: {
        ...candidate.consumerInformation,
        specs: { ...candidate.consumerInformation.specs, ramGb: null },
        facts: [],
      },
    }),
    badCandidate({ consumerInformation: { ...candidate.consumerInformation, facts: [] } }),
    badCandidate({
      consumerInformation: {
        ...candidate.consumerInformation,
        facts: [{ ...candidate.consumerInformation.facts[0], sourceUrl: source.canonicalUrl }],
      },
    }),
    badCandidate({ affiliateUrl: "https://evil.example/" }),
    badCandidate({ expiresAt: candidate.observedAt }),
    { search: { ...value.search, examined: -1 } },
  ]) {
    upstream = { tag: "ok", value: { ...value, ...patch } };
    await assert.rejects(
      compareConsumerProducts(source.canonicalUrl, "laptop", { ramGb: 16 }, "price"),
    );
  }
  const complete = (entry: typeof source) => ({
    ...entry,
    consumerInformation: {
      ...entry.consumerInformation,
      specs: { ...entry.consumerInformation.specs, storageGb: 512, weightG: 1250 },
      facts: [
        ...entry.consumerInformation.facts,
        ...[
          { field: "storageGb", value: 512, quote: "SSD: 512GB" },
          { field: "weightG", value: 1250, quote: "重量: 1.25kg" },
        ].map((fact) => ({
          ...fact,
          sourceUrl: entry.canonicalUrl,
          method: "pattern",
          source: "rakuten_item_api",
        })),
      ],
    },
  });
  const completeSource = complete(source);
  const completeCandidate = complete(candidate);
  upstream = {
    tag: "ok",
    value: {
      ...value,
      categoryDefinition: category,
      providerDefinitions: catalog.providers,
      sort: "recommendation",
      source: completeSource,
      products: [
        {
          ...completeCandidate,
          status: "eligible",
          reasons: [],
          rank: 1,
          recommendationPercent: 100,
          axes: value.products[1]?.axes.map((axis) => ({ ...axis, score: 100 })),
        },
        {
          ...completeSource,
          status: "eligible",
          reasons: [],
          rank: 2,
          recommendationPercent: 85,
          axes: value.products[0]?.axes.map((axis) => ({
            ...axis,
            score: axis.id === "price" ? 38 : 100,
          })),
        },
      ],
    },
  };
  const recommendation = await compareConsumerProducts(
    source.canonicalUrl,
    "laptop",
    { ramGb: 16 },
    "recommendation",
  );
  assert.deepEqual(
    recommendation.products.map((product) => [product.rank, product.recommendationPercent]),
    [
      [1, 100],
      [2, 85],
    ],
  );
  const before = calls;
  await assert.rejects(
    compareConsumerProducts("https://evil.example/product/", "laptop", { ramGb: 16 }, "price"),
  );
  await assert.rejects(
    compareConsumerProducts(source.canonicalUrl, "laptop", { ramGb: Infinity }, "price"),
  );
  await assert.rejects(
    compareConsumerProducts(source.canonicalUrl, "laptop", { smartTv: true }, "price"),
  );
  assert.equal(calls, before);
});

await test("monitor client sends fixed conditions and validates identity, unknown facts, prices, freshness and source retention", async (context) => {
  const conditions: MonitorConditions = {
    screenSize: 27,
    minResolution: "qhd",
    usbCPowerW: 65,
    heightAdjustable: true,
  };
  const listing = (index: number) => {
    const canonicalUrl = `https://item.rakuten.co.jp/shop/monitor-${index}/`;
    return {
      mode: "live",
      notice: "API listing",
      provider: "rakuten",
      condition: "new",
      listingId: `shop:monitor-${index}`,
      productId: null,
      matchMethod: null,
      title: `Monitor MODEL-${index}`,
      shopName: "Example shop",
      canonicalUrl,
      affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/11111111.22222222.33333333.44444444/?${new URLSearchParams({ pc: canonicalUrl, m: canonicalUrl }).toString()}`,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      price: {
        minimum: index === 1 ? 40_000 : 20_000,
        maximum: index === 1 ? 40_000 : 20_000,
        currency: "JPY",
      },
      tax: "included",
      shipping: "excluded",
      availability: "available",
      imageUrl: null,
      identityVerified: true,
      rakutenProductId: String(index).repeat(32),
      genreId: "110105",
      specifications: {
        model: `MODEL-${index}`,
        brand: "Example",
        gtin: index === 1 ? "4549550281836" : "4549550281829",
        color: null,
        maxPowerW: null,
        usbCPorts: null,
        usbAPorts: null,
        weightG: null,
        warrantyMonths: 36,
      },
      monitorSpecifications: {
        screenSizeInches: 27,
        resolutionWidthPx: 2560,
        resolutionHeightPx: 1440,
        refreshRateHz: 100,
        usbCPowerW: 65,
        usbCVideo: true,
        hdmiPorts: 2,
        displayPortPorts: 1,
        heightAdjustable: true,
        warrantyMonths: 36,
      },
    };
  };
  const source = listing(1);
  const cheap = listing(2);
  const products = [
    { ...cheap, status: "eligible", rank: 1, reasons: [] },
    { ...source, status: "eligible", rank: 2, reasons: [] },
  ];
  const value = {
    category: "work-monitor",
    sort: "price",
    conditions,
    source,
    keyword: "モニター",
    aiCalls: 0,
    status: "ranked",
    products,
  };
  let response: unknown = { tag: "ok", value };
  let calls = 0;
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    calls += 1;
    assert.equal(path, "/api/monitors");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    assert.deepEqual(body, { url: source.canonicalUrl, sort: "price", conditions, keyword: null });
    return Promise.resolve(Response.json(response));
  });
  const result = await compareMonitors(source.canonicalUrl, conditions, "price");
  assert.equal(result.products[0]?.price.minimum, 20_000);
  assert.equal(result.aiCalls, 0);
  for (const patch of [
    { aiCalls: 1 },
    { sort: "specifications" },
    { conditions: { ...conditions, usbCPowerW: 90 } },
    { source: { ...source, price: { ...source.price, minimum: 35_000, maximum: 35_000 } } },
    { products: [products[0]] },
    { products: products.map((product) => ({ ...product, rank: 1 })) },
    { products: products.map((product) => ({ ...product, genreId: "560271" })) },
    {
      products: products.map((product) => ({
        ...product,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })),
    },
    {
      products: products.map((product) => ({
        ...product,
        monitorSpecifications: { ...product.monitorSpecifications, usbCVideo: null },
      })),
    },
    {
      products: products.map((product) => ({
        ...product,
        monitorSpecifications: { ...product.monitorSpecifications, hdmiPorts: 2.1 },
      })),
    },
    {
      products: products.map((product) => ({ ...product, affiliateUrl: "https://evil.example/" })),
    },
    { products: [products[0], products[0], products[1]] },
    {
      products: products.map((product) => ({
        ...product,
        price: { ...product.price, maximum: 45_000 },
      })),
    },
  ]) {
    response = { tag: "ok", value: { ...value, ...patch } };
    await assert.rejects(compareMonitors(source.canonicalUrl, conditions, "price"));
  }
  response = {
    tag: "ok",
    value: {
      ...value,
      status: "needs_information",
      source: { ...source, identityVerified: false, rakutenProductId: null },
      products: products.map((product) => ({
        ...product,
        identityVerified: false,
        rakutenProductId: null,
        rank: null,
        status: "pending",
        reasons: ["identity_unknown"],
      })),
    },
  };
  assert.equal(
    (await compareMonitors(source.canonicalUrl, conditions, "price")).products.every(
      (product) => product.rank === null,
    ),
    true,
  );
  const before = calls;
  await assert.rejects(compareMonitors("https://evil.example/", conditions, "price"));
  assert.equal(calls, before);
});

await test("URL comparison sends its mode without charger conditions and rejects unsupported rankings or metadata", async (context) => {
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const listing = (index: number) => {
    const canonicalUrl = `https://item.rakuten.co.jp/shop/product-${index}/`;
    return {
      mode: "live",
      notice: "API listing",
      provider: "rakuten",
      condition: "new",
      listingId: `shop:${index}`,
      productId: null,
      matchMethod: null,
      title: `Charger MODEL-${index}`,
      shopName: "Example shop",
      canonicalUrl,
      affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/11111111.22222222.33333333.44444444/?${new URLSearchParams({ pc: canonicalUrl, m: canonicalUrl }).toString()}`,
      observedAt,
      expiresAt,
      price: { minimum: index * 1000, maximum: index * 1000, currency: "JPY" },
      tax: "included",
      shipping: "excluded",
      availability: "available",
      imageUrl: "https://thumbnail.image.rakuten.co.jp/product.jpg",
      identityVerified: true,
      rakutenProductId: "a".repeat(32),
      specifications: {
        model: `MODEL-${index}`,
        brand: "Example",
        gtin: "4549550281836",
        color: "ブラック",
        maxPowerW: 65,
        usbCPorts: 2,
        usbAPorts: 0,
        weightG: 106,
        warrantyMonths: 12,
      },
    };
  };
  const source = parseInvestigation({ tag: "ok", value: listing(1) });
  assert.ok(source.mode === "live");
  const listings = [listing(2), listing(3)];
  const products = listings.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    recommendationPercent: index === 0 ? 100 : 67,
    axes: [{ id: "price", score: index === 0 ? 100 : 67 }],
    reasons: [],
  }));
  const value = {
    mode: "live",
    comparisonMode: "price",
    source,
    keyword: "USB-C 充電器",
    listings,
    products,
    pending: [],
    status: "ranked",
    scoreBasis: "relative-specification-index-v1",
  };
  let response: unknown = { tag: "ok", value };
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    assert.equal(path, "/api/candidates");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    assert.ok(typeof body === "object" && body !== null && "comparisonMode" in body);
    assert.equal(body.comparisonMode, "price");
    assert.equal("conditions" in body, false);
    return Promise.resolve(
      new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }),
    );
  });
  assert.equal((await compareProducts(source, "price", "")).products.length, 2);
  for (const patch of [
    { source: { ...source, identityVerified: false } },
    { products: products.map((entry) => ({ ...entry, rank: 1 })) },
    { status: "needs_information" },
    {
      listings: listings.map((entry) => ({ ...entry, imageUrl: "https://evil.example/image.png" })),
    },
    {
      listings: listings.map((entry) => ({
        ...entry,
        specifications: { ...entry.specifications, usbCPorts: 99 },
      })),
    },
  ]) {
    response = { tag: "ok", value: { ...value, ...patch } };
    await assert.rejects(compareProducts(source, "price", ""));
  }
  response = {
    tag: "ok",
    value: {
      ...value,
      status: "needs_information",
      products: products.map((entry) => ({ ...entry, rank: null, recommendationPercent: null })),
    },
  };
  assert.equal((await compareProducts(source, "price", "")).products[0]?.rank, null);
});

await test("official results validate SKU metadata, provenance, device assignments and source retention", async (context) => {
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const source = parseInvestigation({
    tag: "ok",
    value: {
      mode: "official",
      notice: "Official",
      provider: "elecom",
      listingId: "MPA-ACCP4365BK",
      productId: "MPA-ACCP4365BK",
      title: "ELECOM 65W",
      canonicalUrl: "https://www.elecom.co.jp/products/MPA-ACCP4365BK.html",
      observedAt,
      expiresAt,
      matchMethod: "manufacturer_model_gtin_variant",
      gtin: "4549550281836",
      color: "ブラック",
      weightG: 106,
      dimensionsMm: [52, 38, 40.5],
      maxPowerW: 65,
      portCount: 2,
    },
  });
  const conditions = parseChargerUse({
    devices: [
      {
        id: "laptop",
        protocol: "pd",
        voltageV: 20,
        currentA: 3.25,
        cable: { maxCurrentA: 5, maxVoltageV: 20 },
      },
    ],
    portPreference: "ignore",
    plugPreference: "ignore",
  });
  const product = {
    productId: source.productId,
    title: source.title,
    isSource: true,
    status: "eligible",
    rank: null,
    reasons: [],
    axes: [],
    official: source,
    assignments: [{ deviceId: "laptop", port: "C1" }],
  };
  const value = {
    mode: "official",
    notice: "Official",
    source,
    conditions,
    status: "unranked",
    policyVersion: "usb-c-confirmed-features-v1",
    observedAt,
    expiresAt,
    products: [product],
  };
  assert.equal(parseChargerComparison({ tag: "ok", value }).mode, "official");
  for (const patch of [
    { gtin: "4549550281837" },
    { canonicalUrl: "https://evil.example/" },
    { color: "" },
    { weightG: NaN },
    { dimensionsMm: [52, 38] },
    { portCount: 0 },
    { expiresAt: observedAt },
  ]) {
    assert.throws(() => parseInvestigation({ tag: "ok", value: { ...source, ...patch } }));
  }
  for (const patch of [
    { assignments: [] },
    { assignments: [{ deviceId: "unknown", port: "C1" }] },
    { assignments: [{ deviceId: "laptop", port: "C3" }] },
    { official: { ...source, color: "ホワイト" } },
    { official: { ...source, expiresAt: observedAt } },
  ]) {
    assert.throws(() =>
      parseChargerComparison({
        tag: "ok",
        value: { ...value, products: [{ ...product, ...patch }] },
      }),
    );
  }
  const ranked = {
    ...value,
    conditions: { ...conditions, plugPreference: "prefer_folding" },
    status: "ranked",
    products: [
      {
        ...product,
        rank: 2,
        axes: [{ id: "plug_storage", level: 2, source: source.canonicalUrl, observedAt }],
      },
    ],
  };
  assert.throws(() => parseChargerComparison({ tag: "ok", value: ranked }), /順位/);
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    assert.equal(path, "/api/investigate");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    assert.ok(
      typeof body === "object" && body !== null && "operation" in body && "confirmed" in body,
    );
    assert.equal(body.operation, "compare");
    assert.equal(body.confirmed, true);
    return Promise.resolve(
      new Response(JSON.stringify({ tag: "ok", value }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  assert.equal((await compareChargers(source, conditions, "")).mode, "official");
});

await test("accepts a complete demo result and rejects incomplete data", () => {
  const value = {
    mode: "demo",
    notice: "Artificial local data",
    provider: "rakuten",
    listingId: "demo-shop:demo-product",
    productId: "demo-product-001",
    title: "Artificial demo product",
    canonicalUrl: "https://item.rakuten.co.jp/demo-shop/demo-product/",
    matchMethod: "model",
    observedAt: "2026-09-26T00:00:00.000Z",
  };
  assert.equal(parseInvestigation({ tag: "ok", value }).productId, "demo-product-001");
  const { productId: _productId, ...incomplete } = value;
  assert.throws(() => parseInvestigation({ tag: "ok", value: incomplete }));
  assert.throws(() =>
    parseInvestigation({ tag: "ok", value: { ...value, canonicalUrl: "javascript:alert(1)" } }),
  );
});

await test("live listing is distinct from identified products and validates its price and expiry", () => {
  const value = {
    mode: "live",
    notice: "Listing only",
    provider: "rakuten",
    listingId: "shop:1234",
    productId: null,
    matchMethod: null,
    title: "Example",
    shopName: "Example shop",
    canonicalUrl: "https://item.rakuten.co.jp/shop/url-slug/",
    affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/11111111.22222222.33333333.44444444/?${new URLSearchParams({ pc: "https://item.rakuten.co.jp/shop/url-slug/", m: "https://item.rakuten.co.jp/shop/url-slug/" }).toString()}`,
    observedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:15:00.000Z",
    price: { minimum: 1000, maximum: 2000, currency: "JPY" },
    tax: "included",
    shipping: "excluded",
    availability: "available",
  };
  assert.equal(parseInvestigation({ tag: "ok", value }).productId, null);
  assert.equal(
    parseCandidateSearch({ tag: "ok", value: { keyword: "充電器", listings: [value] } }).listings
      .length,
    1,
  );
  for (const search of [
    { keyword: "", listings: [value] },
    { keyword: "充電器", listings: [value, value] },
    { keyword: "充電器", listings: [{ ...value, availability: "unavailable" }] },
    { keyword: "充電器", listings: [{ ...value, affiliateUrl: "https://evil.example/" }] },
    { keyword: "充電器", listings: Array.from({ length: 7 }, () => value) },
  ]) {
    assert.throws(() => parseCandidateSearch({ tag: "ok", value: search }));
  }
  assert.throws(
    () => parseCandidateSearch({ tag: "err", error: { code: "main_ai_not_configured" } }),
    /OPENAI_API_KEY/,
  );
  for (const patch of [
    { productId: "invented" },
    { matchMethod: "invented" },
    { shopName: undefined },
    { price: { ...value.price, minimum: -1 } },
    { price: { ...value.price, maximum: 999 } },
    { expiresAt: value.observedAt },
    { observedAt: "2026-02-30T00:00:00.000Z" },
    { canonicalUrl: "https://evil.example/item/" },
    { tax: "unknown" },
    { affiliateUrl: undefined },
    { affiliateUrl: value.affiliateUrl.replace("hb.afl.rakuten.co.jp", "evil.example") },
    { affiliateUrl: value.affiliateUrl.replaceAll("url-slug", "another-item") },
    { affiliateUrl: `${value.affiliateUrl}&pc=https%3A%2F%2Fevil.example%2F` },
    {
      affiliateUrl: value.affiliateUrl.replace(
        "m=https%3A%2F%2Fitem.rakuten.co.jp%2Fshop%2Furl-slug%2F",
        "m=https%3A%2F%2Fevil.example%2F",
      ),
    },
  ]) {
    assert.throws(() => parseInvestigation({ tag: "ok", value: { ...value, ...patch } }));
  }
  assert.throws(
    () => parseInvestigation({ tag: "err", error: { code: "unauthorized" } }),
    /トークン/,
  );
  assert.throws(
    () => parseInvestigation({ tag: "err", error: { code: "provider_rate_limited" } }),
    /利用制限/,
  );
});
await test("comparison client sends confirmed conditions, validates evidence and refuses changed sources or conditions", async (context) => {
  const conditions = parseChargerUse({
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
    plugPreference: "prefer_fixed",
  });
  const source = parseInvestigation({
    tag: "ok",
    value: {
      mode: "demo",
      notice: "Artificial",
      provider: "rakuten",
      listingId: "demo-shop:demo-product",
      productId: "demo-65w",
      title: "Artificial demo product",
      canonicalUrl: "https://item.rakuten.co.jp/demo-shop/demo-product/",
      matchMethod: "model",
      observedAt: "2026-10-01T00:00:00.000Z",
    },
  });
  const product = {
    productId: "demo-65w",
    title: "demo-65w",
    isSource: true,
    status: "eligible",
    rank: 1,
    reasons: [],
    axes: [
      {
        id: "plug_storage",
        level: 2,
        source: "https://example.com/demo-65w",
        observedAt: source.observedAt,
      },
    ],
  };
  const value = {
    mode: "demo",
    notice: "Artificial",
    source,
    conditions,
    status: "ranked",
    policyVersion: "usb-c-confirmed-features-v1",
    observedAt: source.observedAt,
    expiresAt: "2026-10-01T01:00:00.000Z",
    products: [product],
  };
  assert.equal(parseChargerComparison({ tag: "ok", value }).status, "ranked");
  for (const patch of [
    { products: [] },
    { products: [product, product] },
    { source: { ...source, productId: "changed" } },
    { products: [{ ...product, status: "pending" }] },
    { products: [{ ...product, rank: null }] },
    { products: [{ ...product, axes: [] }] },
    { products: [{ ...product, axes: [...product.axes, ...product.axes] }] },
    { products: [{ ...product, axes: [{ ...product.axes[0], source: "javascript:alert(1)" }] }] },
    { products: [{ ...product, axes: [{ ...product.axes[0], level: 3 }] }] },
    {
      products: [
        { ...product, axes: [{ ...product.axes[0], observedAt: "2026-10-01T00:10:00.000Z" }] },
      ],
    },
    { conditions: { ...conditions, plugPreference: "ignore" } },
    { status: "no_match", products: [{ ...product, rank: null }] },
  ]) {
    assert.throws(() => parseChargerComparison({ tag: "ok", value: { ...value, ...patch } }));
  }
  for (const devices of [
    [],
    [{ ...conditions.devices[0], protocol: "invented" }],
    [{ ...conditions.devices[0], currentA: Infinity }],
    [...conditions.devices, ...conditions.devices],
  ]) {
    assert.throws(() => parseChargerUse({ ...conditions, devices }));
  }
  let upstream: unknown = { tag: "ok", value };
  let calls = 0;
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    calls++;
    assert.equal(path, "/api/investigate");
    assert.equal(options.method, "POST");
    assert.ok(typeof options.body === "string");
    const request: unknown = JSON.parse(options.body);
    assert.ok(
      typeof request === "object" &&
        request !== null &&
        "conditions" in request &&
        "confirmed" in request &&
        "url" in request &&
        "operation" in request,
    );
    assert.equal(request.confirmed, true);
    assert.equal(request.operation, "compare");
    assert.equal(request.url, source.canonicalUrl);
    assert.deepEqual(request.conditions, conditions);
    return Promise.resolve(
      new Response(JSON.stringify(upstream), { headers: { "content-type": "application/json" } }),
    );
  });
  assert.equal((await compareChargers(source, conditions, "")).status, "ranked");
  for (const patch of [
    { source: { ...source, listingId: "demo-shop:changed" } },
    { conditions: { ...conditions, plugPreference: "prefer_folding" } },
  ]) {
    upstream = { tag: "ok", value: { ...value, ...patch } };
    await assert.rejects(compareChargers(source, conditions, ""), /比較対象や条件/);
  }
  const before = calls;
  await assert.rejects(compareChargers(source, conditions, "x".repeat(201)), /200文字/);
  assert.equal(calls, before);
});

await test("catalog parser rejects malicious metadata and accepts weighted axes", () => {
  const catalog = testCatalog();
  assert.equal(parseProductCatalog({ tag: "ok", value: catalog }).categories.length, 1);
  assert.throws(() =>
    parseProductCatalog({
      tag: "ok",
      value: {
        categories: [
          {
            ...catalog.categories[0],
            axes: [{ id: "price", label: "価格", lowerIsBetter: true, weight: -1 }],
          },
        ],
        providers: catalog.providers,
      },
    }),
  );
  assert.throws(() =>
    parseProductCatalog({
      tag: "ok",
      value: {
        categories: [{ ...catalog.categories[0], mainFields: ["missing-field"] }],
        providers: catalog.providers,
      },
    }),
  );
});

await test("comparison jobs honor idempotency, abort, revision and capability headers", async (context) => {
  resetConsumerCatalogCache();
  const catalog = testCatalog();
  const category = catalog.categories[0];
  assert.ok(category !== undefined);
  let revision = 0;
  const listing = {
    mode: "live",
    notice: "API listing",
    provider: "rakuten",
    condition: "new",
    listingId: "shop:job-1",
    productId: null,
    matchMethod: null,
    title: "Job laptop",
    shopName: "Example shop",
    canonicalUrl: "https://item.rakuten.co.jp/shop/job-1/",
    affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/11111111.22222222.33333333.44444444/?${new URLSearchParams({ pc: "https://item.rakuten.co.jp/shop/job-1/", m: "https://item.rakuten.co.jp/shop/job-1/" }).toString()}`,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    price: { minimum: 1000, maximum: 1000, currency: "JPY" },
    tax: "included",
    shipping: "excluded",
    availability: "available",
    identityVerified: true,
    rakutenProductId: "a".repeat(32),
    specifications: {
      model: "MODEL-1",
      brand: null,
      gtin: "4549550281836",
      color: null,
      maxPowerW: null,
      usbCPorts: null,
      usbAPorts: null,
      weightG: null,
      warrantyMonths: null,
    },
    consumerInformation: {
      specs: Object.fromEntries(
        category.fields.map((field) => [field.id, field.id === "ramGb" ? 16 : null]),
      ),
      facts: [
        {
          field: "ramGb",
          value: 16,
          quote: "16GB",
          sourceUrl: "https://item.rakuten.co.jp/shop/job-1/",
          method: "pattern",
          source: "rakuten_item_api",
        },
      ],
      conflicts: [],
    },
    status: "eligible",
    rank: null,
    recommendationPercent: null,
    axes: category.axes.map((axis) => ({ id: axis.id, label: axis.label, score: null })),
    reasons: [],
  };
  const comparison = {
    category: category.id,
    categoryDefinition: category,
    providerDefinitions: catalog.providers,
    conditions: { ramGb: 16 },
    sort: "specifications",
    source: listing,
    status: "compared",
    products: [listing],
    aiCalls: { openai: 0, jev: 0 },
    extractionStatus: "not_needed",
    search: {
      pages: 1,
      examined: 1,
      duplicates: 0,
      excluded: 0,
      pending: 0,
      stopReason: "exhausted",
    },
  };
  context.mock.method(globalThis, "fetch", (path: unknown, options: RequestInit) => {
    if (path === "/api/catalog") {
      return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
    }
    if (path === "/api/comparisons") {
      const headers = new Headers(options.headers);
      assert.equal(headers.get("x-comparison-key"), "capability-key-12345678901234567890");
      assert.equal(typeof options.body, "string");
      revision += 1;
      return Promise.resolve(
        Response.json({
          tag: "ok",
          value: {
            id: "job-1",
            accessKey: "capability-key-12345678901234567890",
            state: "queued",
            revision,
            stage: "queued",
            progress: { pages: 0, examined: 0 },
            expiresAt: new Date(Date.now() + 900000).toISOString(),
            result: null,
            error: null,
          },
        }),
      );
    }
    if (path === "/api/comparisons/job-1") {
      const headers = new Headers(options.headers);
      assert.equal(headers.get("x-comparison-key"), "capability-key-12345678901234567890");
      return Promise.resolve(
        Response.json({
          tag: "ok",
          value: {
            id: "job-1",
            state: "succeeded",
            revision: revision + 1,
            stage: "done",
            progress: { pages: 1, examined: 1 },
            expiresAt: new Date(Date.now() + 900000).toISOString(),
            result: comparison,
            error: null,
          },
        }),
      );
    }
    if (path === "/api/comparisons/job-1/cancel") {
      return Promise.resolve(
        Response.json({
          tag: "ok",
          value: {
            id: "job-1",
            state: "cancelled",
            revision: revision + 2,
            stage: "cancelled",
            progress: null,
            expiresAt: new Date(Date.now() + 900000).toISOString(),
            result: null,
            error: null,
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ tag: "err", error: { code: "invalid_request" } }));
  });
  const started = await startConsumerComparisonJob(
    {
      url: listing.canonicalUrl,
      category: category.id,
      conditions: { ramGb: 16 },
      sort: "price",
      idempotencyKey: "fixed-key",
    },
    { accessToken: "a".repeat(32), comparisonKey: "capability-key-12345678901234567890" },
  );
  assert.equal(started.state, "queued");
  const finished = await pollConsumerComparisonJob("job-1", {
    accessToken: "a".repeat(32),
    comparisonKey: "capability-key-12345678901234567890",
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result?.products.length, 1);
  const cancelled = await cancelConsumerComparisonJob("job-1", {
    accessToken: "a".repeat(32),
    comparisonKey: "capability-key-12345678901234567890",
  });
  assert.equal(cancelled.state, "cancelled");
  resetConsumerCatalogCache();
  const catalogAgain = await fetchProductCatalog();
  assert.equal(catalogAgain.categories.length, 1);
});

await test("comparison UI helpers expose stable stage labels and poll rules", () => {
  assert.match(comparisonStageLabel("running", "search"), /探索/);
  assert.match(comparisonStageLabel("running", "score"), /100点満点/);
  assert.equal(phaseFromJobState("running"), "running");
  assert.equal(shouldPollJob("queued"), true);
  assert.equal(shouldPollJob("succeeded"), false);
});

await test("public compare routes restore category and sort", () => {
  assert.deepEqual(parsePublicCompareRoute("/compare/laptop/price/"), {
    category: "laptop",
    sort: "price",
  });
  assert.deepEqual(parsePublicCompareRoute("/private/jobs/"), { category: null, sort: null });
  assert.deepEqual(parsePublicCompareRoute("/category/air_purifier/"), {
    category: "air_purifier",
    sort: null,
  });
});

await test("automatic Jev scores validate evidence, normalization, a shared total basis and call bounds", () => {
  const fixture = genericFixture();
  const catalog = {
    ...fixture.catalog,
    providers: fixture.catalog.providers.map((provider) => ({
      ...provider,
      automaticCategories: true,
    })),
  };
  const category = {
    id: "different_303017",
    label: "コーヒー",
    description: "コーヒーを比較",
    allowUnknownCondition: true,
    fields: [
      {
        id: "attribute1",
        label: "重量",
        unit: "",
        kind: "text",
        filter: null,
        minimum: 0,
        maximum: 0,
        presets: [],
      },
    ],
    mainFields: ["attribute1"],
    axes: [
      { id: "price", label: "価格", lowerIsBetter: true, weight: 1 },
      { id: "attribute1", label: "重量", lowerIsBetter: false, weight: 1, method: "jev" },
    ],
  } satisfies ProductCatalog["categories"][number];
  const products = fixture.comparison.products.map((product, index) => {
    const value = index === 0 ? "2g" : "200g";
    return {
      ...product,
      rank: index === 0 ? 2 : 1,
      recommendationPercent: index === 0 ? 25 : 100,
      consumerInformation: {
        specs: { attribute1: value },
        facts: [
          {
            field: "attribute1",
            value,
            quote: `重量: ${value}`,
            sourceUrl: product.canonicalUrl,
            source: "different_item_api",
            method: "jev_choice",
          },
        ],
        conflicts: [],
      },
      axes: [
        { id: "price", label: "価格", score: index === 0 ? 50 : 100 },
        {
          id: "attribute1",
          label: "重量",
          score: index === 0 ? 0 : 100,
          assessment: { model: "jev-1.13.0", index: index === 0 ? 0 : 4, confidence: 0.9 },
        },
      ],
    };
  });
  const source = products[0];
  assert.ok(source !== undefined);
  const result = {
    ...fixture.comparison,
    category: category.id,
    categoryDefinition: category,
    providerDefinitions: catalog.providers,
    conditions: {},
    source,
    products,
    scoreBasis: ["price", "attribute1"],
    aiCalls: { openai: 0, jev: 5 },
  };
  const parsed = parseConsumerComparison({ tag: "ok", value: result }, catalog);
  assert.equal(parsed.products[0]?.axes[1]?.score, 0);
  assert.equal(parsed.products[1]?.recommendationPercent, 100);
  assert.deepEqual(parsed.scoreBasis, ["price", "attribute1"]);
  assert.deepEqual(
    comparisonDetailLayout(parsed.categoryDefinition, parsed.products).primaryAxes.map(
      (axis) => axis.id,
    ),
    ["attribute1"],
  );
  for (const patch of [
    { aiCalls: { openai: 0, jev: 9 } },
    { scoreBasis: ["price"] },
    { scoreBasis: ["price", "invented"] },
    { scoreBasis: ["price", "attribute1", "attribute1"] },
    { scoreBasis: undefined },
    { products: products.map((product) => ({ ...product, recommendationPercent: 99 })) },
    {
      products: products.map((product) => ({
        ...product,
        axes: product.axes.map((axis) => ({ ...axis, assessment: undefined })),
      })),
    },
    ...[
      { model: "other", index: 2, confidence: 0.9 },
      { model: "jev-1.13.0", index: 5, confidence: 0.9 },
      { model: "jev-1.13.0", index: 2, confidence: 0.59 },
      { model: "jev-1.13.0", index: 2, confidence: 0.9 },
    ].map((assessment) => ({
      products: products.map((product) => ({
        ...product,
        axes: product.axes.map((axis) => (axis.id === "price" ? axis : { ...axis, assessment })),
      })),
    })),
  ]) {
    assert.throws(() =>
      parseConsumerComparison({ tag: "ok", value: { ...result, ...patch } }, catalog),
    );
  }
  const missing = {
    ...source,
    listingId: "sku-3",
    canonicalUrl: "https://shop.different.test/product/3",
    affiliateUrl: "https://partner.different.test/link/3?partner=sample",
    recommendationPercent: null,
    rank: null,
    consumerInformation: { specs: { attribute1: null }, facts: [], conflicts: [] },
    axes: [
      { id: "price", label: "価格", score: 50 },
      { id: "attribute1", label: "重量", score: null },
    ],
  };
  const partial = parseConsumerComparison(
    {
      tag: "ok",
      value: {
        ...result,
        status: "needs_information",
        products: [...products.map((product) => ({ ...product, rank: null })), missing],
      },
    },
    catalog,
  );
  assert.equal(partial.products[2]?.recommendationPercent, null);
  assert.equal(partial.products[0]?.recommendationPercent, 25);
});

await test("automatically discovered categories validate without the startup catalog and survive job restoration", async (context) => {
  resetConsumerCatalogCache();
  const fixture = genericFixture();
  const catalog = {
    ...fixture.catalog,
    providers: fixture.catalog.providers.map((provider) => ({
      ...provider,
      automaticCategories: true,
    })),
  };
  const category = {
    id: "different_201184",
    label: "白米",
    description: "白米の商品を比較",
    allowUnknownCondition: true,
    fields: [
      {
        id: "attribute11",
        label: "総重量",
        unit: "",
        kind: "text",
        filter: null,
        minimum: 0,
        maximum: 0,
        presets: [],
      },
    ],
    mainFields: ["attribute11"],
    axes: [{ id: "price", label: "価格", lowerIsBetter: true, weight: 1 }],
  } satisfies ProductCatalog["categories"][number];
  const products = fixture.comparison.products.map((product) => ({
    ...product,
    condition: "unknown",
    rank: null,
    recommendationPercent: null,
    consumerInformation: {
      specs: { attribute11: "5kg" },
      facts: [
        {
          field: "attribute11",
          value: "5kg",
          quote: "総重量: 5kg",
          sourceUrl: product.canonicalUrl,
          source: "different_item_api",
          method: "pattern",
        },
      ],
      conflicts: [],
    },
    axes: [{ id: "price", label: "価格", score: product.price.minimum === 1000 ? 100 : 50 }],
  }));
  const source = products[0];
  assert.ok(source !== undefined);
  const result = {
    ...fixture.comparison,
    category: category.id,
    categoryDefinition: category,
    providerDefinitions: catalog.providers,
    source,
    products,
    conditions: {},
    status: "needs_information",
    aiCalls: { openai: 0, jev: 2 },
    categorySelectionStatus: "applied",
  };
  const parsed = parseConsumerComparison({ tag: "ok", value: result }, catalog);
  assert.equal(parsed.categoryDefinition.label, "白米");
  assert.equal(parsed.products[0]?.consumerInformation.specs["attribute11"], "5kg");
  assert.equal(parsed.aiCalls.jev, 2);
  const originalProvider = catalog.providers[0];
  assert.ok(originalProvider !== undefined);
  const otherProvider = { ...originalProvider, id: "other", automaticCategories: true };
  const otherCatalog = { ...catalog, providers: [...catalog.providers, otherProvider] };
  assert.throws(
    () =>
      parseConsumerComparison(
        {
          tag: "ok",
          value: {
            ...result,
            category: "other_201184",
            categoryDefinition: { ...category, id: "other_201184" },
            providerDefinitions: otherCatalog.providers,
          },
        },
        otherCatalog,
      ),
    /カテゴリ定義/,
  );
  assert.deepEqual(
    comparisonDetailLayout(
      category,
      products.map((product) => ({
        ...product,
        consumerInformation: {
          ...product.consumerInformation,
          specs: { attribute11: null },
          facts: [],
        },
      })),
      "applied",
    ).specificationFields.map((field) => field.id),
    ["attribute11"],
  );
  assert.throws(
    () => parseConsumerComparison({ tag: "ok", value: result }, fixture.catalog),
    /カテゴリ定義/,
  );
  for (const patch of [
    { aiCalls: { openai: 0, jev: 9 } },
    { categoryDefinition: { ...category, mainFields: ["invented"] } },
    { products: products.map((product) => ({ ...product, condition: "used" })) },
    {
      products: products.map((product) => ({
        ...product,
        consumerInformation: { ...product.consumerInformation, facts: [] },
      })),
    },
    { categorySelectionStatus: "invented" },
  ]) {
    assert.throws(() =>
      parseConsumerComparison({ tag: "ok", value: { ...result, ...patch } }, catalog),
    );
  }
  const detectedValue = {
    status: "detected",
    source: { ...source, consumerInformation: undefined },
    category: category.id,
    categories: [category.id],
    categoryDefinition: category,
    aiCalls: { openai: 0, jev: 1 },
    categorySelectionStatus: "applied",
  };
  assert.equal(
    parseDetectResult({ tag: "ok", value: detectedValue }, catalog).category,
    category.id,
  );
  assert.throws(() =>
    parseDetectResult(
      {
        tag: "ok",
        value: { ...detectedValue, categoryDefinition: { ...category, id: "different_123" } },
      },
      catalog,
    ),
  );

  const operation = createComparisonOperation();
  const job = {
    id: "discovered-job",
    state: "succeeded",
    revision: 2,
    stage: null,
    progress: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    result,
    error: null,
  };
  context.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/catalog") {
      return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
    }
    if (path === "/api/detect") {
      return Promise.resolve(Response.json({ tag: "ok", value: detectedValue }));
    }
    if (path === "/api/comparisons") {
      assert.ok(typeof init?.body === "string");
      const payload: unknown = JSON.parse(init.body);
      assert.ok(typeof payload === "object" && payload !== null && "category" in payload);
      assert.equal(payload.category, category.id);
    }
    return Promise.resolve(Response.json({ tag: "ok", value: job }));
  });
  await detectProductCategory(source.canonicalUrl);
  const started = await startConsumerComparisonJob(
    {
      url: source.canonicalUrl,
      category: category.id,
      conditions: {},
      sort: "recommendation",
      idempotencyKey: operation.idempotencyKey,
    },
    { comparisonKey: operation.accessKey },
  );
  assert.equal(started.result?.category, category.id);
  resetConsumerCatalogCache();
  assert.equal(
    (await readConsumerComparisonJob(job.id, { comparisonKey: operation.accessKey })).result
      ?.category,
    category.id,
  );
});

await test("consumer client validates partial evidence cohorts, common-axis totals and pending rank fences", () => {
  const { catalog, category, comparison } = genericFixture();
  const measurements = [
    { price: 2000, cleanAirM3H: 100, noiseDb: 40, scores: [50, 50, 50], total: 50 },
    { price: 1000, cleanAirM3H: 200, noiseDb: 50, scores: [100, 100, 40], total: 80 },
    { price: 4000, cleanAirM3H: null, noiseDb: 20, scores: [25, null, 100], total: 50 },
  ];
  const products = measurements.map((measurement, index) => {
    const base = comparison.products[index] ?? comparison.products[1];
    if (base === undefined) {
      throw new Error("Missing product fixture");
    }
    const canonicalUrl = `https://shop.different.test/product/${index + 1}`;
    const specs = { cleanAirM3H: measurement.cleanAirM3H, noiseDb: measurement.noiseDb };
    return {
      ...base,
      listingId: `sku-${index + 1}`,
      canonicalUrl,
      affiliateUrl: `https://partner.different.test/link/${index + 1}?partner=sample`,
      identityVerified: false,
      price: { minimum: measurement.price, maximum: measurement.price, currency: "JPY" },
      consumerInformation: {
        specs,
        facts: Object.entries(specs).flatMap(([field, value]) =>
          value === null
            ? []
            : [
                {
                  field,
                  value,
                  quote: `${field}: ${value}`,
                  sourceUrl: canonicalUrl,
                  source: "different_item_api",
                  method: "pattern",
                },
              ],
        ),
        conflicts: [],
      },
      axes: category.axes.map((axis, axisIndex) => ({
        id: axis.id,
        label: axis.label,
        score: measurement.scores[axisIndex],
      })),
      recommendationPercent: measurement.total,
      rank: index === 1 ? 1 : 2,
    };
  });
  const partial = {
    ...comparison,
    conditions: {},
    source: products[0],
    products,
    status: "ranked",
  };
  const parsed = parseConsumerComparison({ tag: "ok", value: partial }, catalog);
  assert.deepEqual(
    parsed.products.map((product) => [
      product.axes.map((axis) => axis.score),
      product.recommendationPercent,
      product.rank,
    ]),
    [
      [[50, 50, 50], 50, 2],
      [[100, 100, 40], 80, 1],
      [[25, null, 100], 50, 2],
    ],
  );
  assert.equal(
    parsed.products.every((product) => !product.identityVerified),
    true,
  );
  for (const entries of [
    products.map((product, index) => ({
      ...product,
      recommendationPercent: index === 1 ? 90 : product.recommendationPercent,
    })),
    products.map((product) => ({
      ...product,
      axes: product.axes.map((axis) => ({ ...axis, score: 100 })),
    })),
    products.map((product) => ({
      ...product,
      consumerInformation: { ...product.consumerInformation, facts: [] },
    })),
  ]) {
    assert.throws(() =>
      parseConsumerComparison({ tag: "ok", value: { ...partial, products: entries } }, catalog),
    );
  }
  assert.throws(() =>
    parseConsumerComparison(
      {
        tag: "ok",
        value: {
          ...partial,
          status: "ranked",
          products: products.map((product, index) => ({ ...product, rank: index === 1 ? 1 : 3 })),
        },
      },
      catalog,
    ),
  );
  const rangedProducts = products.map((product, index) => ({
    ...product,
    price: index === 1 ? { ...product.price, maximum: 1200 } : product.price,
    axes: product.axes.map((axis) => ({
      ...axis,
      score: axis.id === "price" ? (index === 1 ? null : index === 0 ? 100 : 50) : axis.score,
    })),
    recommendationPercent: index === 0 ? 50 : index === 1 ? 40 : 100,
    rank: index === 2 ? 1 : index === 0 ? 2 : 3,
  }));
  const mixedPriceValue = { ...partial, source: rangedProducts[0], products: rangedProducts };
  const mixedPrices = parseConsumerComparison({ tag: "ok", value: mixedPriceValue }, catalog);
  assert.equal(mixedPrices.status, "ranked");
  assert.deepEqual(
    mixedPrices.products.map((product) => [
      product.axes.map((axis) => axis.score),
      product.recommendationPercent,
      product.rank,
    ]),
    [
      [[100, 50, 50], 50, 2],
      [[null, 100, 40], 40, 3],
      [[50, null, 100], 100, 1],
    ],
  );
  assert.throws(() =>
    parseConsumerComparison({ tag: "ok", value: { ...mixedPriceValue, sort: "price" } }, catalog),
  );
  const pendingProducts = products.map((product, index) => ({
    ...product,
    rank: null,
    status: index === 2 ? "pending" : "eligible",
    reasons: index === 2 ? ["cleanAirM3H_unknown"] : [],
    axes: product.axes.map((axis, axisIndex) => ({
      ...axis,
      score:
        index === 2
          ? null
          : [index === 0 ? 50 : 100, index === 0 ? 50 : 100, index === 0 ? 100 : 80][axisIndex],
    })),
    recommendationPercent: index === 2 ? null : index === 0 ? 58 : 97,
  }));
  const pendingValue = {
    ...partial,
    conditions: { cleanAirM3H: 100 },
    source: pendingProducts[0],
    products: pendingProducts,
    status: "needs_information",
    search: { ...partial.search, pending: 1 },
  };
  const pending = parseConsumerComparison({ tag: "ok", value: pendingValue }, catalog);
  assert.deepEqual(
    pending.products.map((product) => product.recommendationPercent),
    [58, 97, null],
  );
  assert.equal(
    pending.products.every((product) => product.rank === null),
    true,
  );
  assert.throws(() =>
    parseConsumerComparison(
      {
        tag: "ok",
        value: {
          ...pendingValue,
          status: "ranked",
          products: pendingProducts.map((product, index) => ({
            ...product,
            rank: index === 2 ? null : index === 0 ? 2 : 1,
          })),
        },
      },
      catalog,
    ),
  );
  const priceOnlyProducts = products.map((product) => ({
    ...product,
    rank: null,
    consumerInformation: { specs: { cleanAirM3H: null, noiseDb: null }, facts: [], conflicts: [] },
    axes: product.axes.map((axis) => ({ ...axis, score: axis.id === "price" ? axis.score : null })),
    recommendationPercent: null,
  }));
  const priceOnly = parseConsumerComparison(
    {
      tag: "ok",
      value: {
        ...partial,
        source: priceOnlyProducts[0],
        products: priceOnlyProducts,
        status: "needs_information",
      },
    },
    catalog,
  );
  assert.equal(
    priceOnly.products.every(
      (product) => product.recommendationPercent === null && product.rank === null,
    ),
    true,
  );
  assert.throws(() =>
    parseConsumerComparison(
      {
        tag: "ok",
        value: {
          ...partial,
          source: priceOnlyProducts[0],
          products: priceOnlyProducts.map((product, index) => ({
            ...product,
            rank: index === 1 ? 1 : index === 0 ? 2 : 3,
          })),
        },
      },
      catalog,
    ),
  );
});

await test("new categories and genuinely different providers validate evidence, condition and weighted score direction", () => {
  const { catalog, category, source, comparison } = genericFixture();
  const result = parseConsumerComparison({ tag: "ok", value: comparison }, catalog);
  assert.equal(result.category, "air_purifier");
  assert.equal(result.products[1]?.recommendationPercent, 97);
  assert.equal(result.source.imageUrl, "https://cdn.different.test/1.webp");
  assert.equal(result.source.affiliateUrl, "https://partner.different.test/link/1?partner=sample");
  assert.equal(comparisonAxisWeightPercent(category, "price"), 100 / 3);
  assert.equal(comparisonAxisWeightPercent(category, "cleanAirM3H"), 50);
  assert.equal(comparisonAxisWeightPercent(category, "noiseDb"), 100 / 6);
  assert.ok(
    Math.abs(
      category.axes.reduce(
        (total, axis) => total + comparisonAxisWeightPercent(category, axis.id),
        0,
      ) - 100,
    ) < 1e-9,
  );
  assert.equal(comparisonDisplayExpiresAt(result), Date.parse(comparison.storageExpiresAt));
  for (const condition of ["used", "refurbished", "unknown", undefined]) {
    const detected = parseDetectResult(
      {
        tag: "ok",
        value: {
          status: "unsupported",
          source: { ...source, condition, consumerInformation: undefined },
          category: null,
          categories: [],
        },
      },
      catalog,
    );
    assert.equal(detected.source?.condition, condition ?? "unknown");
    assert.throws(
      () =>
        parseConsumerComparison(
          {
            tag: "ok",
            value: {
              ...comparison,
              source: { ...source, condition },
              products: comparison.products.map((entry) => ({ ...entry, condition })),
            },
          },
          catalog,
        ),
      /新品/,
    );
  }
  for (const patch of [
    {
      categoryDefinition: {
        ...category,
        axes: category.axes.map((axis) => ({ ...axis, weight: axis.weight + 1 })),
      },
    },
    {
      categoryDefinition: {
        ...category,
        axes: category.axes.map((axis) => ({ ...axis, lowerIsBetter: !axis.lowerIsBetter })),
      },
    },
    { products: comparison.products.map((entry) => ({ ...entry, recommendationPercent: 100 })) },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        axes: entry.axes.map((axis) => ({ ...axis, score: 100 })),
      })),
    },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        affiliateUrl: "https://unregistered.test/link",
      })),
    },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        affiliateUrl: `${entry.affiliateUrl}&destination=https%3A%2F%2Fevil.test%2F`,
      })),
    },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        canonicalUrl: "https://other-provider.test/item",
      })),
    },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        consumerInformation: { ...entry.consumerInformation, facts: [] },
      })),
    },
    {
      products: comparison.products.map((entry) => ({
        ...entry,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      })),
    },
    {
      providerDefinitions: catalog.providers.map((provider) => ({
        ...provider,
        affiliateHosts: ["evil.test"],
      })),
    },
    { storageExpiresAt: new Date(Date.now() - 1).toISOString() },
  ]) {
    assert.throws(() =>
      parseConsumerComparison({ tag: "ok", value: { ...comparison, ...patch } }, catalog),
    );
  }
});

await test("operation keys recover lost start responses and capability-free snapshots, including finish winning cancel", async (context) => {
  resetConsumerCatalogCache();
  const { catalog, source, comparison } = genericFixture();
  const operation = createComparisonOperation();
  const nextOperation = createComparisonOperation();
  assert.notEqual(operation.idempotencyKey, nextOperation.idempotencyKey);
  assert.notEqual(operation.accessKey, nextOperation.accessKey);
  const inputs: unknown[] = [];
  let attempts = 0;
  const snapshot = {
    id: "generic-job",
    state: "queued",
    revision: 0,
    stage: "queued",
    progress: { pages: 0, examined: 0 },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
  context.mock.method(globalThis, "fetch", (url: unknown, options: RequestInit) => {
    options.signal?.throwIfAborted();
    if (url === "/api/catalog") {
      return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
    }
    assert.equal(new Headers(options.headers).get("x-comparison-key"), operation.accessKey);
    if (url === "/api/comparisons") {
      assert.ok(typeof options.body === "string");
      inputs.push(JSON.parse(options.body));
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Response lost after accept");
      }
      return Promise.resolve(Response.json({ tag: "ok", value: snapshot }, { status: 202 }));
    }
    if (url === "/api/comparisons/generic-job") {
      return Promise.resolve(
        Response.json({
          tag: "ok",
          value: { ...snapshot, state: "running", revision: 1, stage: "search" },
        }),
      );
    }
    if (url === "/api/comparisons/generic-job/cancel") {
      return Promise.resolve(
        Response.json({
          tag: "ok",
          value: { ...snapshot, state: "succeeded", revision: 2, result: comparison },
        }),
      );
    }
    return Promise.resolve(
      Response.json({ tag: "err", error: { code: "invalid_request" } }, { status: 400 }),
    );
  });
  const input = {
    url: source.canonicalUrl,
    category: "air_purifier",
    sort: "recommendation",
    conditions: { cleanAirM3H: 100 },
    idempotencyKey: operation.idempotencyKey,
  } satisfies Parameters<typeof startConsumerComparisonJob>[0];
  const options = { accessToken: "a".repeat(32), comparisonKey: operation.accessKey };
  await assert.rejects(startConsumerComparisonJob(input, options), /Response lost/);
  const started = await startConsumerComparisonJob(input, options);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(started.accessKey, operation.accessKey);
  const running = await pollConsumerComparisonJob(started.id, {
    ...options,
    expectedRevision: started.revision,
  });
  assert.equal(running.state, "running");
  assert.equal((await readConsumerComparisonJob(started.id, options)).revision, running.revision);
  await assert.rejects(
    pollConsumerComparisonJob(started.id, { ...options, expectedRevision: 2 }),
    /古く/,
  );
  const cancelled = await cancelConsumerComparisonJob(started.id, options);
  assert.equal(cancelled.state, "succeeded");
  assert.equal(cancelled.result?.category, "air_purifier");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startConsumerComparisonJob(input, { ...options, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(attempts, 2);
  for (const key of ["", "a".repeat(31), "a".repeat(257)]) {
    await assert.rejects(
      startConsumerComparisonJob(input, { ...options, comparisonKey: key }),
      /キー|鍵/,
    );
    await assert.rejects(
      readConsumerComparisonJob(started.id, { ...options, comparisonKey: key }),
      /キー|鍵/,
    );
  }
  assert.equal(attempts, 2);
  assert.throws(
    () =>
      parseComparisonJob(
        { tag: "ok", value: { ...snapshot, expiresAt: new Date(Date.now() - 1).toISOString() } },
        catalog,
        operation.accessKey,
      ),
    /有効期限/,
  );
  assert.throws(
    () =>
      parseComparisonJob(
        { tag: "ok", value: { ...snapshot, accessKey: nextOperation.accessKey } },
        catalog,
        operation.accessKey,
      ),
    /鍵/,
  );
});

await test("generic synchronous comparison preserves non-trailing paths and query variants", async (context) => {
  resetConsumerCatalogCache();
  const { catalog, source, comparison } = genericFixture();
  let response: unknown = { tag: "ok", value: comparison };
  const requests: unknown[] = [];
  context.mock.method(globalThis, "fetch", (url: unknown, options: RequestInit) => {
    if (url === "/api/catalog") {
      return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
    }
    assert.equal(url, "/api/compare");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    requests.push(body);
    return Promise.resolve(Response.json(response));
  });
  const compare = (url: string) =>
    compareConsumerProducts(url, "air_purifier", { cleanAirM3H: 100 }, "recommendation");
  assert.equal((await compare(source.canonicalUrl)).source.canonicalUrl, source.canonicalUrl);
  const withUrl = (canonicalUrl: string) => {
    const changed = {
      ...source,
      canonicalUrl,
      consumerInformation: {
        ...source.consumerInformation,
        facts: source.consumerInformation.facts.map((fact) => ({
          ...fact,
          sourceUrl: canonicalUrl,
        })),
      },
    };
    return {
      ...comparison,
      source: changed,
      products: comparison.products.map((product) =>
        product.listingId === source.listingId ? { ...product, ...changed } : product,
      ),
    };
  };
  const variantUrl = `${source.canonicalUrl}?variant=white&size=2`;
  response = { tag: "ok", value: withUrl(variantUrl) };
  assert.equal((await compare(variantUrl)).source.canonicalUrl, variantUrl);
  assert.ok(typeof requests[1] === "object" && requests[1] !== null && "url" in requests[1]);
  assert.equal(requests[1].url, variantUrl);
  response = { tag: "ok", value: withUrl(`${source.canonicalUrl}?variant=black&size=2`) };
  await assert.rejects(compare(variantUrl), /比較対象/);
  response = { tag: "ok", value: withUrl(`${source.canonicalUrl}/`) };
  await assert.rejects(compare(source.canonicalUrl), /比較対象/);
});

await test("detect, comparison and cancel request scopes ignore delayed replies and abort waits on replacement or cleanup", async () => {
  for (const stage of ["detect", "comparison", "cancel"]) {
    const scope = createComparisonRequestScope();
    const first = scope.begin();
    const delayed = deferred<string>();
    let visible = `current-${stage}`;
    const completion = delayed.promise.then((value) => {
      if (first.isCurrent()) {
        visible = value;
      }
    });
    const second = scope.begin();
    assert.equal(first.signal.aborted, true);
    assert.equal(second.isCurrent(), true);
    delayed.resolve(`stale-${stage}`);
    await completion;
    assert.equal(visible, `current-${stage}`);
    const wait = waitForComparisonPoll(second.signal, 10_000);
    const aborted = assert.rejects(wait, { name: "AbortError" });
    scope.invalidate();
    await aborted;
    assert.equal(second.isCurrent(), false);
  }
});

await test("reload identity stores no product or API token and rejects expired or malformed sessions", (context) => {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    clear: () => {
      entries.clear();
    },
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  context.after(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    } else {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    }
  });
  const operation = createComparisonOperation();
  const session = {
    jobId: "reload-job",
    accessKey: operation.accessKey,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revision: 4,
  };
  const withPrivateFields = {
    ...session,
    accessToken: "private-api-token",
    product: "private product",
  };
  writeComparisonSession("air_purifier", withPrivateFields);
  assert.deepEqual(readComparisonSession("air_purifier"), session);
  assert.equal(readActiveComparisonCategory(), "air_purifier");
  const saved = entries.get("url-product-compare:job:air_purifier") ?? "";
  assert.equal(saved.includes("private"), false);
  const parsed: unknown = JSON.parse(saved);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.deepEqual(Object.keys(parsed), ["jobId", "accessKey", "expiresAt", "revision"]);
  const secondSession = { ...session, jobId: "quiet-fan-job" };
  writeComparisonSession("quiet_fan", secondSession);
  assert.equal(readActiveComparisonCategory(), "quiet_fan");
  clearComparisonSession("air_purifier");
  assert.equal(readActiveComparisonCategory(), "quiet_fan");
  assert.deepEqual(readComparisonSession("quiet_fan"), secondSession);
  clearComparisonSession("quiet_fan");
  assert.equal(readActiveComparisonCategory(), null);
  assert.equal(entries.size, 0);
  writeComparisonSession("air_purifier", {
    ...session,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(readActiveComparisonCategory(), null);
  assert.equal(entries.size, 0);
  entries.set("url-product-compare:job:air_purifier", JSON.stringify({ ...session, revision: -1 }));
  entries.set("url-product-compare:active-category", "air_purifier");
  assert.equal(readComparisonSession("air_purifier"), null);
  assert.equal(readActiveComparisonCategory(), null);
  entries.set("url-product-compare:active-category", "../../invalid");
  assert.equal(readActiveComparisonCategory(), null);
});

await test("transport rejects non-OK JSON, malformed JSON and token-bearing API bases; detect accepts unreconciled sources", async (context) => {
  resetConsumerCatalogCache();
  const { catalog, source } = genericFixture();
  let response = Response.json({ tag: "ok", value: catalog }, { status: 503 });
  context.mock.method(globalThis, "fetch", () => Promise.resolve(response));
  await assert.rejects(fetchProductCatalog(), /HTTP 503/);
  response = new Response("{", { headers: { "content-type": "application/json" } });
  await assert.rejects(fetchProductCatalog(), SyntaxError);
  await assert.rejects(
    fetchProductCatalog({ apiBase: "https://api.test/?token=secret" }),
    /HTTPS URL/,
  );
  await assert.rejects(
    fetchProductCatalog({ apiBase: "https://user:secret@api.test/" }),
    /HTTPS URL/,
  );
  response = Response.json({ tag: "ok", value: catalog });
  await fetchProductCatalog();
  response = Response.json({
    tag: "ok",
    value: {
      status: "unsupported",
      category: null,
      categories: [],
      source: { ...source, condition: "used", consumerInformation: undefined },
    },
  });
  assert.equal((await detectProductCategory(source.canonicalUrl)).source?.condition, "used");
});

await test("in-flight detect, start and cancel requests reject delayed responses after abort", async (context) => {
  const { catalog, source } = genericFixture();
  for (const stage of ["detect", "start", "cancel"]) {
    resetConsumerCatalogCache();
    const observation: { signal: AbortSignal | null } = { signal: null };
    const invoked = deferred<boolean>();
    const delayed = deferred<Response>();
    const mock = context.mock.method(globalThis, "fetch", (url: unknown, options: RequestInit) => {
      if (url === "/api/catalog") {
        return Promise.resolve(Response.json({ tag: "ok", value: catalog }));
      }
      observation.signal = options.signal ?? null;
      invoked.resolve(true);
      return delayed.promise;
    });
    const controller = new AbortController();
    const operation = createComparisonOperation();
    const options = { signal: controller.signal, comparisonKey: operation.accessKey };
    const pending =
      stage === "detect"
        ? detectProductCategory(source.canonicalUrl, options)
        : stage === "start"
          ? startConsumerComparisonJob(
              {
                url: source.canonicalUrl,
                category: "air_purifier",
                conditions: {},
                sort: "price",
                idempotencyKey: operation.idempotencyKey,
              },
              options,
            )
          : cancelConsumerComparisonJob("delayed-job", options);
    const aborted = assert.rejects(pending, { name: "AbortError" });
    await invoked.promise;
    controller.abort();
    assert.equal(observation.signal?.aborted, true);
    delayed.resolve(Response.json({ tag: "ok", value: {} }));
    await aborted;
    mock.mock.restore();
  }
});
