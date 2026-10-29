import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ok } from "../../comparison/algebra.js";
import { createCommerceService } from "../../comparison/commerce.js";
import type { CommerceListing, CommerceProvider } from "../../comparison/commerce.js";
import { scoreFurusatoListings } from "../../comparison/furusato-scoring.js";
import type { FurusatoOverallScoring } from "../../comparison/furusato-scoring.js";
import { compareFurusatoListings } from "../../comparison/furusato.js";

function listing(
  title: string,
  description: string | null,
  patch: Partial<CommerceListing> = {},
): CommerceListing {
  return {
    source: "satofull",
    id: "1",
    title,
    description,
    url: "https://www.satofull.jp/products/detail.php?product_id=1",
    affiliateUrl: "https://ck.jp.ap.valuecommerce.com/servlet/referral",
    amount: { minimum: 20000, maximum: 20000, currency: "JPY", kind: "donation" },
    priceBasis: "listing",
    condition: "not_applicable",
    availability: "available",
    shipping: "unknown",
    tax: "included",
    observedAt: "2026-10-15T00:00:00.000Z",
    expiresAt: "2026-10-15T00:15:00.000Z",
    usage: { ai: false, priceComparison: true, store: false },
    notices: [],
    ...patch,
  };
}

await test("furusato scores each whole gift once and withholds incomplete, weak or unauthorized scores", async () => {
  const clock = (): number => Date.parse("2026-10-15T00:01:00.000Z");
  let calls = 0;
  let confidence = 1;
  const score: FurusatoOverallScoring = (input) => {
    calls += 1;
    assert.equal(input.items.length, 2);
    assert.ok(
      input.items.every((item) =>
        item.profile.fields.some(
          (field) => field.id === "cultivar" && field.value === "コシヒカリ",
        ),
      ),
    );
    assert.ok(input.pairs.every((pair) => pair.unitDonationComparable));
    return Promise.resolve(
      ok(
        Object.fromEntries(
          input.items.map((item) => [
            item.listingId,
            { model: "jev-1.13.0", index: item.donation === 18000 ? 3 : 2, confidence },
          ]),
        ),
      ),
    );
  };
  const listings = [
    listing("白米 コシヒカリ 10kg 一括配送", "配送: 常温\n包装: チャック付き袋", {
      id: "1",
      amount: { minimum: 18000, maximum: 18000, currency: "JPY", kind: "donation" },
      usage: { ai: true, priceComparison: true, store: false },
    }),
    listing("白米 コシヒカリ 10kg 一括配送", "配送: 常温\n包装: 通常袋", {
      id: "2",
      usage: { ai: true, priceComparison: true, store: false },
    }),
  ];
  const comparison = compareFurusatoListings(listings);
  const applied = await scoreFurusatoListings(listings, comparison, score, clock);
  assert.equal(calls, 1);
  assert.equal(applied.status, "applied");
  assert.equal(applied.items[0]?.rank, 1);
  assert.equal(applied.items[1]?.rank, 2);
  assert.equal(applied.scope, "overall");
  assert.equal(applied.items[0].score, 75);
  assert.equal(applied.items[1].score, 50);
  assert.ok(applied.items.every((item) => !Object.hasOwn(item, "axes")));
  assert.ok(!Object.hasOwn(applied, "basis"));
  confidence = 0.1;
  const weak = await scoreFurusatoListings(listings, comparison, score, clock);
  assert.equal(weak.status, "needs_information");
  assert.ok(weak.items.every((item) => item.score === null && item.rank === null));
  const denied = listings.map((item) => ({ ...item, usage: { ...item.usage, ai: false } }));
  assert.equal(
    (await scoreFurusatoListings(denied, comparison, score, clock)).status,
    "not_authorized",
  );
  assert.equal(
    (await scoreFurusatoListings(listings, comparison, undefined, clock)).status,
    "not_configured",
  );
  assert.equal(
    (await scoreFurusatoListings(listings, comparison, score, () => clock() + 900000)).status,
    "needs_information",
  );
  assert.equal(calls, 2);
  const incomplete: FurusatoOverallScoring = () => Promise.resolve(ok({}));
  assert.equal(
    (await scoreFurusatoListings(listings, comparison, incomplete, clock)).status,
    "needs_information",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scoreFurusatoListings(listings, comparison, score, clock, controller.signal),
    { name: "AbortError" },
  );
});

await test("furusato extracts category-specific fields with exact API evidence and normalized package mass", () => {
  const source = listing(
    "【ふるさと納税】白米 コシヒカリ １０ｋｇ 一括配送",
    "内容量：５ｋｇ×２袋。産地: 新潟県。配送: 常温。発送時期: 2026年11月。賞味期限: 精米後30日。2026年産",
  );
  const item = compareFurusatoListings([source]).items[0];
  assert.ok(item !== undefined);
  assert.equal(item.category.value, "rice");
  const fields = new Map(item.fields.map((field) => [field.id, field]));
  assert.equal(fields.get("totalGrams")?.value, 10000);
  assert.equal(fields.get("perDeliveryGrams")?.value, 10000);
  assert.equal(fields.get("deliveryCount")?.value, 1);
  assert.equal(fields.get("cultivar")?.value, "コシヒカリ");
  assert.equal(fields.get("milling")?.value, "白米");
  assert.equal(fields.get("origin")?.value, "新潟県");
  assert.equal(fields.get("harvestYear")?.value, "2026年産");
  assert.equal(fields.get("shipment")?.value, "2026年11月");
  assert.equal(item.donationPerKg, 2000);
  for (const field of [item.category, ...item.fields]) {
    for (const evidence of field.evidence) {
      assert.ok(
        (evidence.source === "title" ? source.title : (source.description ?? "")).includes(
          evidence.quote,
        ),
      );
    }
  }
  assert.ok(
    fields
      .get("totalGrams")
      ?.evidence.some((evidence) => evidence.quote.includes("５ｋｇ×２袋")) === true,
  );
});

await test("furusato retains labelled gift conditions and literal allergy declarations without guessing absent fields", () => {
  const source = listing(
    "豚肉 スライス 1kg 一括配送",
    [
      "自治体: 宮崎県都城市",
      "提供事業者: テスト食品",
      "包装形態: 250g×4パック",
      "原材料名: 豚肉、食塩",
      "アレルギー表示: 卵・乳を含みません",
      "規格: 厚さ3mm",
      "申込期限: 2026年12月31日",
      "配送: 冷凍",
    ].join("\n"),
  );
  const item = compareFurusatoListings([source]).items[0];
  assert.ok(item !== undefined);
  for (const [id, value] of [
    ["municipality", "宮崎県都城市"],
    ["provider", "テスト食品"],
    ["packaging", "250g×4パック"],
    ["ingredients", "豚肉、食塩"],
    ["allergens", "卵・乳を含みません"],
    ["size", "厚さ3mm"],
    ["applicationDeadline", "2026年12月31日"],
  ]) {
    const actual: (typeof item.fields)[number] | undefined = item.fields.find(
      (field) => field.id === id,
    );
    assert.equal(actual?.value, value);
    assert.equal(actual?.status, "known");
    assert.ok(
      actual.evidence.every((evidence) => source.description?.includes(evidence.quote) === true),
    );
  }
  const missing = compareFurusatoListings([
    listing("北海道産 いくら 500g", "おすすめの事業者。アレルギーについてはお問い合わせください。"),
  ]).items[0];
  assert.equal(missing?.fields.find((field) => field.id === "municipality")?.status, "unknown");
  assert.equal(missing.fields.find((field) => field.id === "allergens")?.status, "unknown");
  const conflict = compareFurusatoListings([listing("米 10kg", "自治体: A市\n自治体: B市")])
    .items[0];
  assert.equal(conflict?.fields.find((field) => field.id === "municipality")?.status, "conflict");
});

await test("furusato keeps per-delivery, count and total separate and blocks conflicting or ambiguous quantities", () => {
  const cases = [
    {
      title: "白米 定期便 毎月5kg 全6回",
      description: "産地: 新潟県",
      per: 5000,
      count: 6,
      total: 30000,
      price: 666.67,
    },
    { title: "白米 5kg×6回", description: null, per: 5000, count: 6, total: 30000, price: 666.67 },
    {
      title: "白米 定期便 合計30kg",
      description: "毎回5kg。全6回。",
      per: 5000,
      count: 6,
      total: 30000,
      price: 666.67,
    },
    {
      title: "白米 定期便 5kg 全6回",
      description: null,
      per: null,
      count: 6,
      total: null,
      price: null,
    },
    {
      title: "白米 毎月5kg 全6回",
      description: "合計20kg",
      per: null,
      count: null,
      total: null,
      price: null,
    },
    {
      title: "白米 10kg",
      description: "内容量: 5kg",
      per: null,
      count: null,
      total: null,
      price: null,
    },
    { title: "白米 約10kg", description: null, per: null, count: null, total: null, price: null },
    {
      title: "白米 5kg〜10kg 選べる",
      description: null,
      per: null,
      count: null,
      total: null,
      price: null,
    },
    {
      title: "牛肉 1kg",
      description: "内容量: 牛肉1kg + たれ200g",
      per: null,
      count: null,
      total: null,
      price: null,
    },
    {
      title: "牛肉 定期便 500g×2パック×6回",
      description: null,
      per: 1000,
      count: 6,
      total: 6000,
      price: 3333.33,
    },
    {
      title: "白米",
      description: "栄養成分100g当たり エネルギー342kcal",
      per: null,
      count: null,
      total: null,
      price: null,
    },
    { title: "白米", description: null, per: null, count: null, total: null, price: null },
    {
      title: "牛肉100gあたりの参考価格",
      description: null,
      per: null,
      count: null,
      total: null,
      price: null,
    },
    {
      title: "白米 1,000g 一括配送",
      description: null,
      per: 1000,
      count: 1,
      total: 1000,
      price: 20000,
    },
    {
      title: "牛肉 500g + 豚肉 500g",
      description: null,
      per: null,
      count: null,
      total: null,
      price: null,
    },
    {
      title: "白米 毎月5kg 全6回",
      description: "全3回。合計30kg",
      per: null,
      count: null,
      total: null,
      price: null,
    },
  ];
  for (const sample of cases) {
    const item = compareFurusatoListings([listing(sample.title, sample.description)]).items[0];
    assert.ok(item !== undefined);
    const fields = new Map(item.fields.map((field) => [field.id, field]));
    assert.equal(fields.get("perDeliveryGrams")?.value, sample.per, sample.title);
    assert.equal(fields.get("deliveryCount")?.value, sample.count, sample.title);
    assert.equal(fields.get("totalGrams")?.value, sample.total, sample.title);
    assert.equal(item.donationPerKg, sample.price, sample.title);
  }
});

await test("furusato chooses food-specific comparison fields without inventing absent specs", () => {
  const cases = [
    {
      title: "黒毛和牛 牛肉 A5 サーロインステーキ 500g",
      category: "meat",
      id: "cut",
      value: "サーロイン",
    },
    { title: "りんご 3kg", category: "fruit", id: "species", value: "りんご" },
    { title: "ホタテ 生食用 1kg", category: "seafood", id: "processing", value: "生食用" },
    { title: "米国産 牛肉 1kg", category: "meat", id: "species", value: "牛" },
  ];
  for (const sample of cases) {
    const item = compareFurusatoListings([listing(sample.title, "産地: 北海道。保存: 冷凍")])
      .items[0];
    assert.ok(item !== undefined);
    assert.equal(item.category.value, sample.category);
    assert.equal(item.fields.find((field) => field.id === sample.id)?.value, sample.value);
    assert.equal(item.fields.find((field) => field.id === "shipment")?.status, "unknown");
  }
  const mixed = compareFurusatoListings([listing("白米と牛肉のセット 2kg", null)]).items[0];
  assert.equal(mixed?.category.status, "conflict");
  assert.equal(mixed.donationPerKg, null);
  const unknown = compareFurusatoListings([listing("宿泊券", "内容量: 1kg")]).items[0];
  assert.equal(unknown?.category.status, "unknown");
  assert.equal(unknown.donationPerKg, null);
  assert.equal(
    compareFurusatoListings([listing("白米 10kg", null, { source: "rakuten" })]).items.length,
    0,
  );
  const negated = compareFurusatoListings([listing("白米 10kg", "定期便ではありません")]).items[0];
  assert.equal(negated?.fields.find((field) => field.id === "deliveryMode")?.status, "unknown");
});

await test("furusato reports price comparability separately from table differences and never mixes delivery modes", () => {
  const first = listing("白米 コシヒカリ 10kg 一括配送", "配送: 常温");
  const second = listing("白米 コシヒカリ 5kg 一括配送", "配送: 常温", {
    source: "rakuten_furusato",
    id: "shop:2",
  });
  const same = compareFurusatoListings([first, second]);
  assert.equal(same.pairs[0]?.status, "comparable");
  assert.equal(same.pairs[0].unitDonationComparable, true);
  const periodic = compareFurusatoListings([
    first,
    { ...second, title: "白米 コシヒカリ 毎月5kg 全6回" },
  ]);
  assert.equal(periodic.pairs[0]?.status, "partial");
  assert.ok(periodic.pairs[0].reasons.includes("deliveryMode_different"));
  assert.equal(periodic.pairs[0].unitDonationComparable, false);
  assert.equal(
    compareFurusatoListings([first, { ...second, title: "牛肉 1kg" }]).pairs[0]?.status,
    "incompatible",
  );
  assert.equal(
    compareFurusatoListings([first, { ...second, description: null }]).pairs[0]
      ?.unitDonationComparable,
    false,
  );
  for (const patch of [
    { availability: "unavailable" },
    { amount: { minimum: 10000, maximum: 20000, kind: "donation", currency: "JPY" } },
    { usage: { ai: false, priceComparison: false, store: false } },
  ] satisfies ReadonlyArray<Partial<CommerceListing>>) {
    assert.equal(compareFurusatoListings([{ ...first, ...patch }]).items[0]?.donationPerKg, null);
  }
});

await test("furusato service validates all lookup references before fetching, combines sources and refuses duplicate resolved items", async () => {
  const calls: string[] = [];
  const providers = (
    ["satofull", "rakuten_furusato"] satisfies ReadonlyArray<"satofull" | "rakuten_furusato">
  ).map((source): CommerceProvider => ({
    source,
    request: (input) => {
      calls.push(`${source}:${input.query}`);
      return Promise.resolve(
        ok({
          listings: [
            listing("白米 コシヒカリ 10kg 一括配送", "配送: 常温", {
              source,
              id: source === "satofull" ? "1" : "shop:1",
            }),
          ],
          total: 1,
          page: input.page,
          limit: input.operation === "lookup" ? 1 : input.limit,
        }),
      );
    },
  }));
  const service = createCommerceService(providers);
  for (const input of [
    null,
    { items: [] },
    { items: [{ source: "satofull", query: "1" }] },
    {
      items: [
        { source: "satofull", query: "1" },
        { source: "amazon", query: "x" },
      ],
    },
    {
      items: [
        { source: "satofull", query: "1" },
        { source: "satofull", query: "1" },
      ],
    },
    {
      items: [
        { source: "satofull", query: "1" },
        { source: "satofull", query: "https://127.0.0.1/private" },
      ],
    },
    {
      items: [
        { source: "satofull", query: "1" },
        { source: "rakuten_furusato", query: "https://evil.example/shop/id/" },
      ],
    },
  ]) {
    assert.equal((await service.compareFurusato(input)).tag, "err");
  }
  assert.equal(calls.length, 0);
  const result = await service.compareFurusato({
    items: [
      { source: "satofull", query: "1" },
      { source: "rakuten_furusato", query: "https://item.rakuten.co.jp/shop/1/" },
    ],
  });
  assert.equal(result.tag, "ok");
  assert.equal(result.value.furusato?.items.length, 2);
  assert.equal(result.value.furusato.pairs[0]?.unitDonationComparable, true);
  assert.equal(
    (
      await service.compareFurusato({
        items: [
          { source: "satofull", query: "1" },
          { source: "satofull", query: "alias" },
        ],
      })
    ).tag,
    "err",
  );
  const search = await service.request({ source: "satofull", operation: "search", query: "白米" });
  assert.equal(search.tag, "ok");
  assert.equal(search.value.furusato?.items[0]?.category.value, "rice");
});
