import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiHandler } from "../../bootstrap.js";
import { createAuroraRunStore } from "../aws/aurora.js";
import { parseApiRequest } from "../http/request.js";

const event = {
  version: "2.0",
  rawPath: "/api/investigate",
  rawQueryString: "",
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" }),
  isBase64Encoded: false,
} as const;

await test("Lambda boundary validates unknown input before comparison", async () => {
  const handler = createApiHandler(null);
  assert.equal((await handler(event)).statusCode, 200);
  for (const input of [
    null,
    {},
    { ...event, body: "{" },
    { ...event, body: "[]" },
    { ...event, isBase64Encoded: true },
    { ...event, body: JSON.stringify({ url: "x".repeat(2049) }) },
  ]) {
    assert.equal((await handler(input)).statusCode, 400);
  }
  assert.equal((await handler({ ...event, rawPath: "/missing" })).statusCode, 404);
  assert.equal(
    (await handler({ ...event, requestContext: { http: { method: "DELETE" } } })).statusCode,
    405,
  );
  assert.equal(
    (await handler({ ...event, body: JSON.stringify({ url: "https://example.com/" }) })).statusCode,
    422,
  );
  assert.equal(
    (
      await handler({
        ...event,
        rawPath: "/api/health",
        requestContext: { http: { method: "GET" } },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    parseApiRequest({
      ...event,
      requestContext: { http: { method: "GET" } },
      rawQueryString: "url=a&url=b",
    }).tag,
    "err",
  );
});

await test("Aurora writes bound metadata only and contains storage errors", async () => {
  const store = createAuroraRunStore("cluster", "secret", "compare", (input) => {
    assert.equal(
      input.sql,
      "INSERT INTO investigation_runs (mode, status) VALUES ('demo', :status)",
    );
    assert.deepEqual(input.parameters, [{ name: "status", value: { stringValue: "succeeded" } }]);
    assert.equal(JSON.stringify(input).includes("rakuten"), false);
    return Promise.resolve({});
  });
  assert.deepEqual(await store("succeeded"), { tag: "ok", value: null });
  const unavailable = createAuroraRunStore("cluster", "secret", "compare", () =>
    Promise.reject(new Error("private credential")),
  );
  assert.deepEqual(await unavailable("failed"), {
    tag: "err",
    error: { code: "storage_unavailable" },
  });
});

const liveSettings = {
  applicationId: "example-app-1234",
  accessKey: "example-access-key-1234567890",
  affiliateId: "11111111.22222222.33333333.44444444",
  allowedOrigin: "https://main.d3f6j2d66bsp2x.amplifyapp.com/",
  authorizedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  accessToken: "example-test-token-12345678901234567890",
} as const;
const liveEvent = {
  ...event,
  headers: { authorization: `Bearer ${liveSettings.accessToken}` },
  body: JSON.stringify({
    url: "https://item.rakuten.co.jp/example-shop/url-slug/",
    keyword: "Example product",
  }),
};
const liveItem = {
  itemCode: "example-shop:10001234",
  itemName: "Example product",
  itemUrl: "https://item.rakuten.co.jp/example-shop/url-slug/?scid=tracking",
  affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${liveSettings.affiliateId}/?${new URLSearchParams({ pc: "https://item.rakuten.co.jp/example-shop/url-slug/", m: "https://item.rakuten.co.jp/example-shop/url-slug/" }).toString()}`,
  shopCode: "example-shop",
  shopName: "Example shop",
  itemPriceBaseField: "item_price_min3",
  itemPriceMin3: 1000,
  itemPriceMax3: 2000,
  taxFlag: 0,
  postageFlag: 0,
  availability: 1,
};

const openaiSettings = { apiKey: "sk-example-openai-key-1234567890", model: "gpt-6-luna" } as const;
const candidateEvent = {
  ...liveEvent,
  rawPath: "/api/candidates",
  body: JSON.stringify({ requirements: "持ち運び用の65W USB-C充電器" }),
};
const planned = {
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ keyword: "65W USB-C 充電器" }) }],
    },
  ],
};

await test("main AI plans search from user input, then verified listings supply all product facts and monetized links", async (context) => {
  const calls: string[] = [];
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.openai.com/v1/responses") {
      calls.push("openai");
      assert.equal(
        new Headers(options.headers).get("Authorization"),
        `Bearer ${openaiSettings.apiKey}`,
      );
      assert.equal(options.redirect, "error");
      assert.equal(typeof options.body, "string");
      assert.ok(typeof options.body === "string");
      const body: unknown = JSON.parse(options.body);
      assert.ok(
        typeof body === "object" &&
          body !== null &&
          "store" in body &&
          "input" in body &&
          "model" in body,
      );
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.input, "持ち運び用の65W USB-C充電器");
      assert.equal(options.body.includes(liveItem.itemName), false);
      assert.equal(options.body.includes(liveSettings.accessKey), false);
      assert.equal(options.body.includes(liveSettings.affiliateId), false);
      return Promise.resolve(new Response(JSON.stringify(planned)));
    }
    assert.ok(input instanceof URL);
    calls.push("rakuten");
    assert.equal(input.origin, "https://openapi.rakuten.co.jp");
    assert.equal(input.searchParams.get("keyword"), "65W USB-C 充電器");
    assert.equal(input.searchParams.get("shopCode"), null);
    assert.equal(input.searchParams.get("hits"), "10");
    assert.equal(input.searchParams.get("affiliateId"), liveSettings.affiliateId);
    return Promise.resolve(
      new Response(
        JSON.stringify({ count: 3, Items: [liveItem, liveItem, { ...liveItem, availability: 0 }] }),
      ),
    );
  });
  const response = await createApiHandler(null, liveSettings, openaiSettings)(candidateEvent);
  assert.equal(response.statusCode, 200);
  const body: unknown = JSON.parse(response.body);
  assert.ok(typeof body === "object" && body !== null && "value" in body);
  assert.ok(
    typeof body.value === "object" &&
      body.value !== null &&
      "listings" in body.value &&
      "keyword" in body.value,
  );
  assert.equal(body.value.keyword, "65W USB-C 充電器");
  const listings: unknown = body.value.listings;
  assert.ok(Array.isArray(listings));
  assert.equal(listings.length, 1);
  const listing: unknown = listings[0];
  assert.ok(
    typeof listing === "object" &&
      listing !== null &&
      "affiliateUrl" in listing &&
      "productId" in listing,
  );
  assert.equal(listing.affiliateUrl, liveItem.affiliateUrl);
  assert.equal(listing.productId, null);
  assert.deepEqual(calls, ["openai", "rakuten"]);
  assert.equal(response.body.includes(openaiSettings.apiKey), false);
  assert.equal(response.headers["cache-control"], "no-store");
});

await test("candidate authentication, missing key, expiry and invalid input stop paid calls", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const handler = createApiHandler(null, liveSettings, openaiSettings);
  assert.equal((await handler({ ...candidateEvent, headers: {} })).statusCode, 401);
  assert.equal(
    (await handler({ ...candidateEvent, requestContext: { http: { method: "GET" } } })).statusCode,
    405,
  );
  for (const requirements of [undefined, " ", "x".repeat(1001), 1]) {
    assert.equal(
      (await handler({ ...candidateEvent, body: JSON.stringify({ requirements }) })).statusCode,
      400,
    );
  }
  const unconfigured = await createApiHandler(null, liveSettings)(candidateEvent);
  assert.equal(unconfigured.statusCode, 503);
  assert.match(unconfigured.body, /main_ai_not_configured/);
  assert.equal(
    (
      await createApiHandler(
        null,
        { ...liveSettings, authorizedUntil: "2026-01-01T00:00:00.000Z" },
        openaiSettings,
      )(candidateEvent)
    ).statusCode,
    422,
  );
  assert.throws(() =>
    createApiHandler(null, liveSettings, { ...openaiSettings, model: "bad/model" }),
  );
});

await test("incomplete, refused, invented and failed AI outputs never become product candidates", async (context) => {
  let upstream = new Response("", { status: 429 });
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    assert.equal(input, "https://api.openai.com/v1/responses");
    return Promise.resolve(upstream);
  });
  const handler = createApiHandler(null, liveSettings, openaiSettings);
  for (const [status, expected] of [
    [429, 429],
    [401, 503],
    [500, 503],
  ] as const) {
    upstream = new Response("private provider diagnostic", { status });
    const response = await handler(candidateEvent);
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.includes("private provider diagnostic"), false);
  }
  for (const body of [
    { ...planned, status: "incomplete" },
    { ...planned, output: [] },
    {
      ...planned,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "no" }],
        },
      ],
    },
    ...[
      { keyword: "" },
      { keyword: "あ".repeat(43) },
      { keyword: "65W", products: ["invented"] },
      { keyword: "bad\nquery" },
    ].map((plan) => ({
      ...planned,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(plan) }],
        },
      ],
    })),
  ]) {
    upstream = new Response(JSON.stringify(body));
    const response = await handler(candidateEvent);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /invalid_ai_response/);
  }
});

await test("live lookup uses an exact URL, preserves SKU ranges and never invents product identity", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    calls++;
    assert.ok(input instanceof URL);
    assert.equal(input.origin, "https://openapi.rakuten.co.jp");
    assert.equal(input.pathname, "/ichibams/api/IchibaItem/Search/20260701");
    assert.equal(input.searchParams.get("itemCode"), null);
    assert.equal(input.searchParams.get("affiliateId"), liveSettings.affiliateId);
    assert.equal(input.searchParams.get("elements")?.split(",").includes("affiliateUrl"), true);
    assert.equal(input.searchParams.get("keyword"), "Example product");
    assert.equal(input.searchParams.get("shopCode"), "example-shop");
    assert.equal(input.searchParams.get("formatVersion"), "2");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("accessKey"), liveSettings.accessKey);
    assert.equal(headers.get("Origin"), "https://main.d3f6j2d66bsp2x.amplifyapp.com");
    assert.equal(options.redirect, "error");
    return Promise.resolve(
      new Response(
        JSON.stringify({ count: 1, Items: [{ ...liveItem, itemUrl: liveItem.affiliateUrl }] }),
      ),
    );
  });
  const handler = createApiHandler(null, liveSettings);
  const response = await handler(liveEvent);
  assert.equal(response.statusCode, 200);
  const result: unknown = JSON.parse(response.body);
  assert.ok(typeof result === "object" && result !== null && "value" in result);
  const value = result.value;
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "productId" in value &&
      "listingId" in value &&
      "price" in value &&
      "affiliateUrl" in value &&
      "matchMethod" in value,
  );
  assert.equal(value.productId, null);
  assert.equal(value.matchMethod, null);
  assert.equal(value.listingId, "example-shop:10001234");
  assert.deepEqual(value.price, { minimum: 1000, maximum: 2000, currency: "JPY" });
  assert.equal(value.affiliateUrl, liveItem.affiliateUrl);
  assert.equal(calls, 1);
  assert.equal(response.body.includes(liveSettings.accessKey), false);
  assert.equal(response.body.includes(liveSettings.accessToken), false);
  assert.equal(response.headers["cache-control"], "no-store");
});

await test("live authorization, expiry and URL validation prevent external calls", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const handler = createApiHandler(null, liveSettings);
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { authorization: `Bearer ${liveSettings.accessToken},other` },
  ]) {
    assert.equal((await handler({ ...liveEvent, headers })).statusCode, 401);
  }
  assert.equal(
    (await handler({ ...liveEvent, headers: { authorization: "x", Authorization: "y" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await handler({
        ...liveEvent,
        requestContext: { http: { method: "GET" } },
        rawQueryString: "url=https://item.rakuten.co.jp/example-shop/url-slug/",
      })
    ).statusCode,
    405,
  );
  for (const url of [
    "https://127.0.0.1/",
    "https://evil.example/shop/item/",
    "https://item.rakuten.co.jp/example-shop/url-slug/?sku=other",
  ]) {
    assert.equal((await handler({ ...liveEvent, body: JSON.stringify({ url }) })).statusCode, 422);
  }
  assert.equal(
    (
      await handler({
        ...liveEvent,
        body: JSON.stringify({
          url: "https://item.rakuten.co.jp/example-shop/url-slug/",
          keyword: "あ".repeat(43),
        }),
      })
    ).statusCode,
    400,
  );
  const expired = createApiHandler(null, {
    ...liveSettings,
    authorizedUntil: "2026-01-01T00:00:00.000Z",
  });
  const denied = await expired(liveEvent);
  assert.equal(denied.statusCode, 422);
  assert.match(denied.body, /source_not_authorized/);
  assert.throws(() => createApiHandler(null, {}));
  assert.throws(() => createApiHandler(null, { ...liveSettings, accessToken: "short" }));
  assert.throws(() => createApiHandler(null, { ...liveSettings, affiliateId: undefined }));
  assert.throws(() => createApiHandler(null, { ...liveSettings, affiliateId: "bad/id" }));
});

await test("live lookup rejects wrong listings, invalid prices and upstream failures", async (context) => {
  let upstream = new Response("", { status: 429 });
  context.mock.method(globalThis, "fetch", () => Promise.resolve(upstream));
  const handler = createApiHandler(null, liveSettings);
  for (const [status, expected, code] of [
    [429, 429, "provider_rate_limited"],
    [403, 503, "provider_unauthorized"],
    [500, 503, "provider_unavailable"],
    [404, 422, "listing_not_found"],
  ] as const) {
    upstream = new Response("private diagnostic", { status });
    const response = await handler(liveEvent);
    assert.equal(response.statusCode, expected);
    assert.match(response.body, new RegExp(code));
    assert.equal(response.body.includes("private diagnostic"), false);
  }
  for (const item of [
    { ...liveItem, itemUrl: "https://item.rakuten.co.jp/example-shop/another-item/" },
    { ...liveItem, itemUrl: "https://evil.example/item/" },
    { ...liveItem, itemPriceMin3: -1 },
    { ...liveItem, itemPriceMax3: 999 },
    { ...liveItem, taxFlag: 9 },
    { ...liveItem, itemCode: "wrong-shop:1234" },
    { ...liveItem, affiliateUrl: undefined },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace(
        liveSettings.affiliateId,
        "aaaaaaaa.bbbbbbbb.cccccccc.dddddddd",
      ),
    },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace("hb.afl.rakuten.co.jp", "evil.example"),
    },
    { ...liveItem, affiliateUrl: `${liveItem.affiliateUrl}&pc=https%3A%2F%2Fevil.example%2F` },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace(
        "m=https%3A%2F%2Fitem.rakuten.co.jp%2Fexample-shop%2Furl-slug%2F",
        "m=https%3A%2F%2Fevil.example%2F",
      ),
    },
  ]) {
    upstream = new Response(JSON.stringify({ count: 1, Items: [item] }));
    assert.equal((await handler(liveEvent)).statusCode, 422);
  }
  upstream = new Response(JSON.stringify({ count: 31, Items: [] }));
  assert.match((await handler(liveEvent)).body, /lookup_incomplete/);
  upstream = new Response(JSON.stringify({ count: 2, Items: [liveItem, liveItem] }));
  assert.match((await handler(liveEvent)).body, /ambiguous_listing/);
  upstream = new Response("{");
  assert.equal((await handler(liveEvent)).statusCode, 503);
});
