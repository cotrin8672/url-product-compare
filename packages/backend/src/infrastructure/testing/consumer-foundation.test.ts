import assert from "node:assert/strict";
import { test } from "node:test";

import { ok } from "../../comparison/algebra.js";
import {
  buildConsumerCatalog,
  consumerCatalogCategories,
  publicConsumerCatalog,
  readConsumerListingCondition,
} from "../../comparison/consumer-catalog.js";
import type {
  ConsumerCategoryDefinition,
  ConsumerFieldDefinition,
} from "../../comparison/consumer-catalog.js";
import type { ConsumerListing, ConsumerProvider } from "../../comparison/consumer-provider.js";
import { createConsumerComparisonService } from "../../comparison/consumer-service.js";
import {
  assessConsumerListing,
  consumerCategory,
  readConsumerInformation,
} from "../../comparison/consumer.js";
import type { ConsumerExtraction } from "../../comparison/consumer.js";
import { instant } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

const now = "2026-10-06T00:00:00.000Z";
const clock = (): Instant => {
  const parsed = instant(now);
  if (parsed.tag === "err") {
    throw new Error("Invalid fixture clock");
  }
  return parsed.value;
};
const noiseField: ConsumerFieldDefinition = Object.freeze({
  id: "noiseDb",
  label: "動作音",
  unit: "dB",
  kind: "number",
  filter: "max",
  minimum: 1,
  maximum: 120,
  presets: Object.freeze([20, 30, 40]),
  extraction: Object.freeze({ kind: "numberPattern", pattern: "動作音\\s*[:：]\\s*(\\d+)\\s*dB" }),
});
const testCategory: ConsumerCategoryDefinition = Object.freeze({
  id: "test_appliance",
  label: "家電テスト",
  description: "別のプロバイダーの動作音を比較",
  providerBindings: Object.freeze({
    synthetic: Object.freeze({ genreId: "home.air.fan", keyword: "静音ファン" }),
  }),
  mainFields: Object.freeze(["noiseDb"]),
  fields: Object.freeze([noiseField]),
  axes: Object.freeze([
    Object.freeze({ id: "price", label: "価格", lowerIsBetter: true, weight: 1 }),
    Object.freeze({ id: "noiseDb", label: "静かさ", lowerIsBetter: true, weight: 2 }),
  ]),
});
const extendedCatalog = buildConsumerCatalog([...consumerCatalogCategories, testCategory]);
const comparisonInput = Object.freeze({
  url: "https://shop.example.test/products/source",
  keyword: null,
  category: "test_appliance",
  conditions: Object.freeze({ noiseDb: 40 }),
  sort: "recommendation",
} satisfies Parameters<ReturnType<typeof createConsumerComparisonService>["compare"]>[0]);

function syntheticListing(
  id: string,
  price: number,
  expiry = "2026-10-06T00:10:00.000Z",
): ConsumerListing {
  return Object.freeze({
    provider: "synthetic",
    condition: "new",
    listingId: id,
    title: "新品 静音ファン",
    canonicalUrl: `https://shop.example.test/products/${id}`,
    affiliateUrl: `https://referrals.example.test/visit/${id}?partner=demo`,
    imageUrl: `https://images.example-cdn.test/${id}.jpg`,
    observedAt: now,
    expiresAt: expiry,
    shopName: "Synthetic shop",
    price: Object.freeze({ minimum: price, maximum: price, currency: "JPY" }),
    tax: "included",
    shipping: "excluded",
    availability: "available",
    identityVerified: true,
    genreId: "fan.quiet.2026",
  });
}

function syntheticProvider(overrides: Partial<ConsumerProvider> = {}): ConsumerProvider {
  const provider: ConsumerProvider = {
    metadata: Object.freeze({
      id: "synthetic",
      label: "Synthetic shop",
      urlHosts: Object.freeze(["shop.example.test"]),
      affiliateHosts: Object.freeze(["referrals.example.test"]),
    }),
    acceptsUrl: (url) => URL.canParse(url) && new URL(url).hostname === "shop.example.test",
    lookup: () => Promise.resolve(ok(syntheticListing("source", 40_000))),
    resolveGenreLineage: () => Promise.resolve(Object.freeze(["home.air.fan"])),
    categoryMatchesLineage: (category, genreId, lineage) => {
      const binding = category.providerBindings?.["synthetic"];
      return (
        binding !== undefined && (genreId === binding.genreId || lineage.includes(binding.genreId))
      );
    },
    search: () =>
      Promise.resolve(
        ok(
          Object.freeze({
            count: 1,
            listings: Object.freeze([
              syntheticListing("quiet", 50_000, "2026-10-06T00:04:00.000Z"),
            ]),
          }),
        ),
      ),
    enrich: (listings) => Promise.resolve(listings),
    attachConsumerInformation: (listing, category) =>
      Object.freeze({
        ...listing,
        consumerInformation: readConsumerInformation(
          category,
          listing.listingId,
          listing.canonicalUrl,
          `動作音: ${listing.listingId === "quiet" ? 20 : 40}dB`,
          "",
          { listing: "synthetic_offer", product: "synthetic_product" },
        ),
      }),
    permissions: () =>
      Object.freeze({
        display: true,
        fetch: true,
        affiliate: true,
        ai: false,
        store: true,
        storeExpiresAt: "2026-10-06T00:08:00.000Z",
      }),
    ...overrides,
  };
  return Object.freeze(provider);
}

await test("injected category routes a real second-provider shape through detection, filtering and weighted ranking", async () => {
  let lineageCalls = 0;
  const provider = syntheticProvider({
    resolveGenreLineage: () => {
      lineageCalls += 1;
      return Promise.resolve(["home.air.fan"]);
    },
  });
  const service = createConsumerComparisonService([provider], undefined, clock, extendedCatalog);
  assert.equal(consumerCategory("test_appliance"), null);
  assert.equal(publicConsumerCatalog().length, 6);
  assert.equal(service.catalog().at(-1)?.id, "test_appliance");
  assert.deepEqual(service.providerDefinitions(), [provider.metadata]);
  assert.equal(service.canStoreResult(comparisonInput.url), true);
  assert.equal(service.canStoreResult("https://unknown.example.test/product"), false);
  assert.equal("providerBindings" in (service.catalog().at(-1) ?? {}), false);
  const detected = await service.detect({ url: comparisonInput.url, keyword: null });
  if (detected.tag !== "ok") {
    throw new Error(detected.error.code);
  }
  assert.equal(detected.value.category, "test_appliance");
  assert.equal(detected.value.status, "detected");
  assert.equal(detected.value.source?.genreId, "fan.quiet.2026");
  assert.equal(detected.value.source.consumerInformation, undefined);
  const compared = await service.compare(comparisonInput);
  if (compared.tag !== "ok") {
    throw new Error(compared.error.code);
  }
  assert.equal(compared.value.status, "ranked");
  assert.equal(compared.value.products[0]?.listingId, "quiet");
  assert.equal(compared.value.products[0].recommendationPercent, 93);
  assert.equal(compared.value.products[1]?.recommendationPercent, 67);
  assert.equal(compared.value.source.provider, "synthetic");
  assert.equal("rakutenProductId" in compared.value.source, false);
  assert.equal(
    compared.value.source.affiliateUrl,
    "https://referrals.example.test/visit/source?partner=demo",
  );
  assert.equal(compared.value.source.imageUrl, "https://images.example-cdn.test/source.jpg");
  assert.equal(compared.value.source.consumerInformation.facts[0]?.source, "synthetic_offer");
  assert.equal(compared.value.source.consumerInformation.facts[0].quote, "動作音: 40dB");
  assert.equal(compared.value.storageExpiresAt, "2026-10-06T00:04:00.000Z");
  assert.equal(lineageCalls, 2);
  const filtered = await service.compare({ ...comparisonInput, conditions: { noiseDb: 30 } });
  if (filtered.tag !== "ok") {
    throw new Error(filtered.error.code);
  }
  assert.equal(filtered.value.source.consumerInformation.specs["noiseDb"], 40);
  assert.equal(
    filtered.value.products.find((product) => product.listingId === "source")?.status,
    "excluded",
  );
  assert.equal(
    filtered.value.products.find((product) => product.listingId === "quiet")?.status,
    "eligible",
  );
});

await test("recommendation refills past incomplete listings and selects matching known specification axes", async () => {
  const pages: number[] = [];
  const provider = syntheticProvider({
    lookup: () =>
      Promise.resolve(ok({ ...syntheticListing("source", 40_000), identityVerified: false })),
    search: (_category, input) => {
      pages.push(input.page);
      return Promise.resolve(
        ok({
          count: 8,
          listings:
            input.page === 1
              ? Array.from({ length: 6 }, (_, index) => ({
                  ...syntheticListing(`unknown-${index}`, 10_000),
                  identityVerified: false,
                }))
              : [syntheticListing("quiet", 50_000), syntheticListing("balanced", 30_000)],
        }),
      );
    },
    attachConsumerInformation: (listing, category) => ({
      ...listing,
      identityVerified: false,
      consumerInformation: readConsumerInformation(
        category,
        listing.listingId,
        listing.canonicalUrl,
        listing.listingId.startsWith("unknown-")
          ? ""
          : `動作音: ${listing.listingId === "quiet" ? 20 : listing.listingId === "balanced" ? 30 : 40}dB`,
      ),
    }),
  });
  const service = createConsumerComparisonService([provider], undefined, clock, extendedCatalog);
  const compared = await service.compare({ ...comparisonInput, conditions: {} });
  assert.equal(compared.tag, "ok");
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(
    new Set(compared.value.products.map((product) => product.listingId)),
    new Set(["source", "quiet", "balanced"]),
  );
  assert.equal(
    compared.value.products.every(
      (product) =>
        product.identityVerified === false && product.axes.every((axis) => axis.score !== null),
    ),
    true,
  );
  pages.length = 0;
  const priced = await service.compare({ ...comparisonInput, conditions: {}, sort: "price" });
  assert.equal(priced.tag, "ok");
  assert.deepEqual(pages, [1]);
  assert.equal(
    priced.value.products.some((product) => product.listingId.startsWith("unknown-")),
    true,
  );
});

await test("missing PC detail axes do not remove candidates that cover the source's first six axes", async () => {
  const laptop = consumerCategory("laptop");
  assert.ok(laptop !== null);
  const catalog = buildConsumerCatalog([
    { ...laptop, providerBindings: { synthetic: { genreId: "home.air.fan", keyword: "PC" } } },
  ]);
  const primary =
    "メモリ: 16GB; SSD: 512GB; 重量: 1400g; バッテリー時間: 14時間; 解像度: 2560×1600; リフレッシュレート: 120Hz";
  const provider = syntheticProvider({
    search: () =>
      Promise.resolve(
        ok({
          count: 2,
          listings: [
            syntheticListing("missing-detail", 30000),
            syntheticListing("full-detail", 50000),
          ],
        }),
      ),
    attachConsumerInformation: (listing, category) => ({
      ...listing,
      consumerInformation: readConsumerInformation(
        category,
        listing.listingId,
        listing.canonicalUrl,
        listing.listingId === "missing-detail" ? primary : `${primary}; GPUメモリ: 8GB`,
      ),
    }),
  });
  const service = createConsumerComparisonService([provider], undefined, clock, catalog);
  const compared = await service.compare({
    ...comparisonInput,
    category: "laptop",
    conditions: {},
  });
  assert.equal(compared.tag, "ok");
  assert.equal(compared.value.status, "ranked");
  assert.deepEqual(
    compared.value.products.map((product) => [
      product.listingId,
      product.rank,
      product.recommendationPercent,
    ]),
    [
      ["missing-detail", 1, 100],
      ["source", 2, 96],
      ["full-detail", 3, 94],
    ],
  );
  const missing = compared.value.products.find((product) => product.listingId === "missing-detail");
  assert.ok(missing !== undefined);
  assert.equal(missing.consumerInformation.specs["gpuVramGb"], null);
  assert.equal(missing.axes.find((axis) => axis.id === "gpuVramGb")?.score, null);
  assert.equal(
    missing.axes
      .filter((axis) => axis.id !== "price")
      .slice(0, 6)
      .every((axis) => axis.score === 100),
    true,
  );
  assert.equal(compared.value.source.consumerInformation.specs["gpuVramGb"], 8);
  assert.equal(
    compared.value.products
      .find((product) => product.listingId === "full-detail")
      ?.axes.find((axis) => axis.id === "gpuVramGb")?.score,
    100,
  );
});

await test("direct provider genre matches skip ancestor requests while unknown genres still resolve", async () => {
  const genres: Array<string | null | undefined> = [];
  const provider = syntheticProvider({
    resolveGenreLineage: (genreId) => {
      genres.push(genreId);
      return Promise.resolve(genreId === "fan.quiet.2026" ? ["home.air.fan"] : []);
    },
    search: () =>
      Promise.resolve(
        ok({
          count: 2,
          listings: [
            { ...syntheticListing("quiet", 50_000), genreId: "home.air.fan" },
            { ...syntheticListing("unrelated", 30_000), genreId: "home.other" },
          ],
        }),
      ),
  });
  const service = createConsumerComparisonService([provider], undefined, clock, extendedCatalog);
  const compared = await service.compare(comparisonInput);
  if (compared.tag === "err") {
    throw new Error(compared.error.code);
  }
  assert.deepEqual(genres, ["fan.quiet.2026", "home.other"]);
  assert.deepEqual(
    compared.value.products.map((product) => product.listingId),
    ["quiet", "source"],
  );
  assert.equal(compared.value.status, "ranked");
});

await test("duplicate provider IDs and ambiguous URL providers are rejected before lookup", async () => {
  let calls = 0;
  const first = syntheticProvider({
    lookup: () => {
      calls += 1;
      return Promise.resolve(ok(syntheticListing("source", 40_000)));
    },
  });
  assert.throws(
    () => createConsumerComparisonService([first, first]),
    /Duplicate consumer provider/,
  );
  const second = syntheticProvider({ metadata: { ...first.metadata, id: "other" } });
  const service = createConsumerComparisonService(
    [first, second],
    undefined,
    clock,
    extendedCatalog,
  );
  assert.deepEqual(await service.detect({ url: comparisonInput.url, keyword: null }), {
    tag: "err",
    error: { code: "ambiguous_provider" },
  });
  assert.deepEqual(await service.compare(comparisonInput), {
    tag: "err",
    error: { code: "ambiguous_provider" },
  });
  assert.equal(calls, 0);
});

await test("ambiguous category lineage requests confirmation and explicit corrections verify lineage", async () => {
  const alternate: ConsumerCategoryDefinition = { ...testCategory, id: "other_appliance" };
  const service = createConsumerComparisonService(
    [syntheticProvider()],
    undefined,
    clock,
    buildConsumerCatalog([testCategory, alternate, ...consumerCatalogCategories]),
  );
  const detected = await service.detect({ url: comparisonInput.url, keyword: null });
  if (detected.tag !== "ok") {
    throw new Error(detected.error.code);
  }
  assert.equal(detected.value.status, "needs_confirmation");
  assert.deepEqual(detected.value.categories, ["test_appliance", "other_appliance"]);
  assert.equal(detected.value.category, null);
  assert.deepEqual(await service.compare({ ...comparisonInput, category: null }), {
    tag: "err",
    error: { code: "needs_confirmation" },
  });
  assert.deepEqual(
    await service.compare({ ...comparisonInput, category: "laptop", conditions: {} }),
    { tag: "err", error: { code: "unsupported_category" } },
  );
});

await test("automatic comparison uses provider lineage and the injected catalog", async () => {
  const service = createConsumerComparisonService(
    [syntheticProvider()],
    undefined,
    clock,
    extendedCatalog,
  );
  const result = await service.compare({ ...comparisonInput, category: null });
  if (result.tag === "err") {
    throw new Error(result.error.code);
  }
  assert.equal(result.value.category, "test_appliance");
  assert.equal(result.value.status, "ranked");
  assert.equal(result.value.products[0]?.listingId, "quiet");
});

await test("consumer extraction receives cancellation and cannot commit answers after cancellation", async () => {
  const laptop = consumerCategory("laptop");
  if (laptop === null) {
    throw new Error("Missing laptop category");
  }
  const category: ConsumerCategoryDefinition = {
    ...laptop,
    providerBindings: { synthetic: { genreId: "home.air.fan", keyword: "PC" } },
  };
  const provider = syntheticProvider({
    search: () => Promise.resolve(ok({ count: 0, listings: [] })),
    permissions: () => ({
      display: true,
      fetch: true,
      affiliate: true,
      ai: true,
      store: false,
      storeExpiresAt: null,
    }),
    attachConsumerInformation: (listing, definition) => ({
      ...listing,
      consumerInformation: readConsumerInformation(
        definition,
        listing.listingId,
        listing.canonicalUrl,
        "作業領域は16GB、保存領域は512GBです。",
        "",
        { listing: "synthetic_offer", product: "synthetic_product" },
      ),
    }),
  });
  const caller = new AbortController();
  let captured: AbortSignal | undefined;
  let choiceCount = 0;
  const extraction: ConsumerExtraction = (choices, options) => {
    captured = options?.signal;
    choiceCount = choices.length;
    caller.abort();
    return Promise.resolve(ok({}));
  };
  const service = createConsumerComparisonService(
    [provider],
    extraction,
    clock,
    buildConsumerCatalog([category]),
  );
  await assert.rejects(
    service.compare(
      { ...comparisonInput, category: "laptop", conditions: {} },
      { signal: caller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(captured, caller.signal);
  assert.ok(choiceCount > 0);
});

await test("unknown and used conditions remain recovered unsupported sources and never compare", async () => {
  for (const condition of ["unknown", "used", "refurbished"] satisfies ReadonlyArray<
    ConsumerListing["condition"]
  >) {
    const source: ConsumerListing = { ...syntheticListing("source", 40_000), condition };
    const service = createConsumerComparisonService(
      [syntheticProvider({ lookup: () => Promise.resolve(ok(source)) })],
      undefined,
      clock,
      extendedCatalog,
    );
    const detected = await service.detect({ url: comparisonInput.url, keyword: null });
    if (detected.tag !== "ok") {
      throw new Error(detected.error.code);
    }
    assert.equal(detected.value.status, "unsupported");
    assert.equal(detected.value.source?.condition, condition);
    assert.deepEqual(await service.compare(comparisonInput), {
      tag: "err",
      error: { code: "listing_not_eligible" },
    });
  }
});

await test("opted-in categories compare unlabelled conditions without turning them into new or admitting used goods", async () => {
  const catalog = buildConsumerCatalog([{ ...testCategory, allowUnknownCondition: true }]);
  for (const condition of ["unknown", "used", "refurbished"] satisfies ReadonlyArray<
    ConsumerListing["condition"]
  >) {
    const source: ConsumerListing = { ...syntheticListing("source", 40_000), condition };
    const service = createConsumerComparisonService(
      [syntheticProvider({ lookup: () => Promise.resolve(ok(source)) })],
      undefined,
      clock,
      catalog,
    );
    const detected = await service.detect({ url: comparisonInput.url, keyword: null });
    if (detected.tag !== "ok") {
      throw new Error(detected.error.code);
    }
    assert.equal(detected.value.status, condition === "unknown" ? "detected" : "unsupported");
    assert.equal(detected.value.source?.condition, condition);
    const compared = await service.compare(comparisonInput);
    if (condition === "unknown") {
      if (compared.tag !== "ok") {
        throw new Error(compared.error.code);
      }
      assert.equal(compared.value.source.condition, "unknown");
      assert.equal(compared.value.status, "ranked");
      assert.equal(compared.value.categoryDefinition.allowUnknownCondition, true);
    } else {
      assert.deepEqual(compared, { tag: "err", error: { code: "listing_not_eligible" } });
    }
  }
});

await test("catalog rejects duplicate IDs, bad field references, bounds, presets and scoring axes", () => {
  const hyphenated: ConsumerCategoryDefinition = { ...testCategory, id: "test-appliance" };
  const catalog = buildConsumerCatalog([hyphenated]);
  assert.equal(catalog.category(hyphenated.id)?.id, hyphenated.id);
  assert.deepEqual(
    catalog.publicCategories().map((category) => category.id),
    [hyphenated.id],
  );
  assert.equal(catalog.category("test/appliance"), null);
  assert.throws(() => buildConsumerCatalog([hyphenated, hyphenated]));
  const invalid: readonly ConsumerCategoryDefinition[] = [
    { ...testCategory, id: "Bad-id" },
    { ...testCategory, id: "test/appliance" },
    { ...testCategory, id: "../test-appliance" },
    { ...testCategory, id: "test%2Dappliance" },
    { ...testCategory, fields: [noiseField, noiseField] },
    { ...testCategory, mainFields: ["missing"] },
    { ...testCategory, fields: [{ ...noiseField, minimum: 121 }] },
    { ...testCategory, fields: [{ ...noiseField, presets: [0] }] },
    { ...testCategory, fields: [{ ...noiseField, presets: [20, 20] }] },
    { ...testCategory, fields: [{ ...noiseField, kind: "text", filter: null }] },
    { ...testCategory, fields: [{ ...noiseField, filter: "required" }] },
    {
      ...testCategory,
      axes: [{ id: "missing", label: "missing", lowerIsBetter: false, weight: 1 }],
    },
    { ...testCategory, axes: [{ id: "price", label: "price", lowerIsBetter: false, weight: 1 }] },
    { ...testCategory, axes: [{ id: "noiseDb", label: "noise", lowerIsBetter: true, weight: 0 }] },
    {
      ...testCategory,
      axes: [{ id: "noiseDb", label: "noise", lowerIsBetter: true, weight: Number.NaN }],
    },
  ];
  assert.throws(() => buildConsumerCatalog([testCategory, testCategory]));
  for (const category of invalid) {
    assert.throws(() => buildConsumerCatalog([category]), category.id);
  }
  const { providerBindings, ...unbound } = testCategory;
  assert.equal(providerBindings?.["synthetic"]?.genreId, "home.air.fan");
  assert.doesNotThrow(() => buildConsumerCatalog([unbound]));
});

await test("listing conditions require positive new evidence and reject negation, unused used and new-old stock", () => {
  const fixtures = [
    ["商品状態:中古", "used"],
    ["新品ではありません", "unknown"],
    ["未使用中古", "used"],
    ["新品 未使用中古", "used"],
    ["中古 Dell Optiplex 新品NVMe512GB", "used"],
    ["未使用", "unknown"],
    ["新古品", "unknown"],
    ["brand new old stock", "unknown"],
    ["新品同様", "unknown"],
    ["未開封中古", "unknown"],
    ["brand new refurbished", "refurbished"],
    ["not new", "unknown"],
    ["商品状態:新品", "new"],
    ["新品未使用", "new"],
    ["【新品】 ノートPC", "new"],
    ["何も記載なし", "unknown"],
  ] satisfies ReadonlyArray<readonly [string, ConsumerListing["condition"]]>;
  for (const [evidence, expected] of fixtures) {
    assert.equal(readConsumerListingCondition("ノートPC", evidence), expected, evidence);
  }
  const listing = syntheticListing("source", 40_000);
  const information = readConsumerInformation(
    testCategory,
    listing.listingId,
    listing.canonicalUrl,
    "動作音: 40dB",
  );
  assert.equal(information.facts[0]?.source, "listing");
  assert.equal(
    assessConsumerListing(
      {
        listingId: "unlabelled",
        availability: "available",
        tax: "included",
        price: listing.price,
        identityVerified: true,
        consumerInformation: information,
      },
      testCategory,
      {},
    ).status,
    "excluded",
  );
});

await test("invalid affiliate candidates are skipped while an invalid source remains an error", async () => {
  const bad: ConsumerListing = {
    ...syntheticListing("bad", 1),
    affiliateUrl: "https://evil.example.test/visit/bad",
  };
  const good = syntheticListing("quiet", 50_000);
  const service = createConsumerComparisonService(
    [syntheticProvider({ search: () => Promise.resolve(ok({ count: 2, listings: [bad, good] })) })],
    undefined,
    clock,
    extendedCatalog,
  );
  const result = await service.compare(comparisonInput);
  if (result.tag !== "ok") {
    throw new Error(result.error.code);
  }
  assert.deepEqual(
    result.value.products.map((listing) => listing.listingId),
    ["quiet", "source"],
  );
  const invalidSource = createConsumerComparisonService(
    [syntheticProvider({ lookup: () => Promise.resolve(ok(bad)) })],
    undefined,
    clock,
    extendedCatalog,
  );
  assert.deepEqual(await invalidSource.compare(comparisonInput), {
    tag: "err",
    error: { code: "invalid_affiliate_url" },
  });
});

await test("storage remains denied unless authorized and expiry is capped by both grant and all listings", async () => {
  for (const [store, storeExpiresAt, expected] of [
    [false, null, null],
    [true, "2026-10-06T00:02:00.000Z", "2026-10-06T00:02:00.000Z"],
    [true, "2026-10-05T23:59:59.000Z", null],
  ] satisfies ReadonlyArray<readonly [boolean, string | null, string | null]>) {
    const provider = syntheticProvider({
      permissions: () => ({
        display: true,
        fetch: true,
        affiliate: true,
        ai: false,
        store,
        storeExpiresAt,
      }),
    });
    const result = await createConsumerComparisonService(
      [provider],
      undefined,
      clock,
      extendedCatalog,
    ).compare(comparisonInput);
    if (result.tag !== "ok") {
      throw new Error(result.error.code);
    }
    assert.equal(result.value.storageExpiresAt, expected);
  }
});
