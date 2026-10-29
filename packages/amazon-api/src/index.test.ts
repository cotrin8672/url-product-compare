import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createAmazonClient } from "./index.js";

const settings = {
  clientId: "test-client",
  clientSecret: "test-secret",
  partnerTag: "sdk-test-22",
};
function item(id = "B000000001"): Readonly<Record<string, unknown>> {
  return {
    asin: id,
    detailPageURL: "https://www.amazon.co.jp/dp/" + id + "?tag=sdk-test-22",
    parentASIN: "B000000000",
    itemInfo: { title: { displayValue: "検証商品" }, features: { displayValues: ["容量: 1L"] } },
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/test.jpg" } } },
    offersV2: {
      listings: [
        {
          isBuyBoxWinner: true,
          violatesMAP: false,
          condition: { value: "New" },
          availability: { type: "IN_STOCK" },
          price: { money: { currency: "JPY", amount: 12000 } },
        },
      ],
    },
  };
}
function token(): Response {
  return Response.json({ access_token: "test-token", token_type: "bearer", expires_in: 3600 });
}

await test("Amazon standalone client uses JP OAuth and supports search, exact batch lookup, variations and API-issued affiliate links", async () => {
  let tokens = 0;
  const operations: string[] = [];
  const client = createAmazonClient(settings, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(init?.redirect, "error");
    assert.ok(typeof init.body === "string");
    const body: unknown = JSON.parse(init.body);
    assert.ok(typeof body === "object" && body !== null);
    if (url.hostname === "api.amazon.co.jp") {
      tokens++;
      assert.deepEqual(body, {
        grant_type: "client_credentials",
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: "creatorsapi::default",
      });
      return Promise.resolve(token());
    }
    assert.equal(url.origin, "https://creatorsapi.amazon");
    assert.equal(new Headers(init.headers).get("x-marketplace"), "www.amazon.co.jp");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
    assert.ok("partnerTag" in body && body.partnerTag === settings.partnerTag);
    assert.ok("marketplace" in body && body.marketplace === "www.amazon.co.jp");
    operations.push(url.pathname);
    if (url.pathname.endsWith("searchItems")) {
      assert.ok("keywords" in body && body.keywords === "保温 ボトル");
      assert.ok("itemPage" in body && body.itemPage === 2);
      return Promise.resolve(
        Response.json({ searchResult: { items: [item()], totalResultCount: 20 } }),
      );
    }
    if (url.pathname.endsWith("getVariations")) {
      assert.ok("asin" in body && body.asin === "B000000000");
      return Promise.resolve(
        Response.json({
          variationsResult: { items: [item()], variationSummary: { variationCount: 2 } },
        }),
      );
    }
    assert.ok("itemIds" in body && Array.isArray(body.itemIds));
    return Promise.resolve(
      Response.json({
        itemsResult: {
          items: body.itemIds.map((id: unknown) => {
            assert.ok(typeof id === "string");
            return item(id);
          }),
        },
      }),
    );
  });
  const search = await client.request({
    operation: "search",
    query: "保温 ボトル",
    page: 2,
    limit: 3,
  });
  assert.equal(search.tag, "ok");
  assert.equal(search.value.items[0]?.title, "検証商品");
  assert.equal(search.value.items[0].imageUrl, "https://m.media-amazon.com/images/I/test.jpg");
  assert.deepEqual(search.value.items[0].features, ["容量: 1L"]);
  assert.equal(search.value.items[0].offer?.amount, 12000);
  const batch = await client.getItems(["B000000001", "B000000002"]);
  assert.ok(batch.tag === "ok" && batch.value.length === 2);
  const variations = await client.getVariations("B000000000");
  assert.ok(variations.tag === "ok" && variations.value.total === 2);
  const link = await client.getAffiliateLink("B000000001");
  assert.deepEqual(link, {
    tag: "ok",
    value: "https://www.amazon.co.jp/dp/B000000001?tag=sdk-test-22",
  });
  assert.equal(tokens, 1);
  assert.equal(operations.length, 4);
});

await test("Amazon validates input before authentication and rejects changed ASINs and foreign attribution", async () => {
  let calls = 0;
  const client = createAmazonClient(settings, () => {
    calls++;
    return Promise.resolve(token());
  });
  for (const request of [
    { operation: "search", query: "" },
    { operation: "search", query: "x", page: 11 },
    { operation: "lookup", query: "invalid" },
  ] satisfies Array<Parameters<typeof client.request>[0]>) {
    assert.deepEqual(await client.request(request), {
      tag: "err",
      error: { code: "invalid_request" },
    });
  }
  assert.equal((await client.getItems(["B000000001", "B000000001"])).tag, "err");
  assert.equal((await client.getVariations("wrong")).tag, "err");
  assert.equal(calls, 0);
  for (const patch of [
    { asin: "B000000002" },
    { detailPageURL: "https://www.amazon.co.jp/dp/B000000001?tag=other-22" },
    { detailPageURL: "https://www.amazon.co.jp.evil.invalid/dp/B000000001?tag=sdk-test-22" },
    { detailPageURL: "https://www.amazon.co.jp/dp/B000000001?tag=sdk-test-22&tag=other-22" },
  ]) {
    const bad = createAmazonClient(settings, (input) =>
      Promise.resolve(
        new URL(input instanceof Request ? input.url : input).hostname === "api.amazon.co.jp"
          ? token()
          : Response.json({ itemsResult: { items: [{ ...item(), ...patch }] } }),
      ),
    );
    assert.deepEqual(await bad.request({ operation: "lookup", query: "B000000001" }), {
      tag: "err",
      error: { code: "invalid_response" },
    });
  }
  assert.throws(() =>
    createAmazonClient({ ...settings, credentialVersion: "3.3", partnerTag: "wrong-20" }),
  );
});

await test("Amazon suppresses MAP and non-JPY prices at the SDK boundary and never invents a featured offer", async () => {
  for (const offer of [
    { isBuyBoxWinner: true, violatesMAP: true, price: { money: { currency: "JPY", amount: 100 } } },
    { isBuyBoxWinner: true, price: { money: { currency: "JPY", amount: 100 } } },
    {
      isBuyBoxWinner: true,
      violatesMAP: false,
      price: { money: { currency: "USD", amount: 100 } },
    },
    {
      isBuyBoxWinner: false,
      violatesMAP: false,
      price: { money: { currency: "JPY", amount: 100 } },
    },
  ]) {
    const client = createAmazonClient(settings, (input) =>
      Promise.resolve(
        new URL(input instanceof Request ? input.url : input).hostname === "api.amazon.co.jp"
          ? token()
          : Response.json({
              itemsResult: { items: [{ ...item(), offersV2: { listings: [offer] } }] },
            }),
      ),
    );
    const response = await client.request({ operation: "lookup", query: "B000000001" });
    assert.ok(response.tag === "ok");
    assert.equal(response.value.items[0]?.offer?.amount ?? null, null);
  }
});

await test("Amazon refreshes expired or denied tokens, honors credential regions and contains upstream errors", async () => {
  let now = 0,
    tokens = 0,
    deny = false;
  const client = createAmazonClient(
    { ...settings, credentialVersion: "3.2" },
    (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.amazon.co.uk") {
        tokens++;
        return Promise.resolve(token());
      }
      return Promise.resolve(
        deny
          ? new Response(settings.clientSecret, { status: 401 })
          : Response.json({ itemsResult: { items: [item()] } }),
      );
    },
    () => now,
  );
  await client.getItems(["B000000001"]);
  now += 3600000;
  await client.getItems(["B000000001"]);
  assert.equal(tokens, 2);
  deny = true;
  const denied = await client.getItems(["B000000001"]);
  assert.deepEqual(denied, { tag: "err", error: { code: "provider_unauthorized" } });
  assert.equal(JSON.stringify(denied).includes(settings.clientSecret), false);
  deny = false;
  await client.getItems(["B000000001"]);
  assert.equal(tokens, 3);
  const limited = createAmazonClient(settings, () =>
    Promise.resolve(new Response("private", { status: 429 })),
  );
  assert.deepEqual(await limited.getItems(["B000000001"]), {
    tag: "err",
    error: { code: "provider_rate_limited" },
  });
});

await test("Amazon bounds streaming responses, preserves split UTF-8 and cancels before leaking data", async () => {
  let cancelled = false,
    calls = 0;
  const client = createAmazonClient(settings, (input) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.amazon.co.jp") {
      return Promise.resolve(token());
    }
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_577));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
  });
  assert.deepEqual(await client.getItems(["B000000001"]), {
    tag: "err",
    error: { code: "invalid_response" },
  });
  assert.equal(cancelled, true);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await client.getItems(["B000000001"], controller.signal), {
    tag: "err",
    error: { code: "provider_unavailable" },
  });
  assert.equal(calls, 2);
  const good = createAmazonClient(settings, (input) => {
    if (new URL(input instanceof Request ? input.url : input).hostname === "api.amazon.co.jp") {
      return Promise.resolve(token());
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ itemsResult: { items: [item()] } }));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(sink) {
            for (const value of bytes) {
              sink.enqueue(Uint8Array.of(value));
            }
            sink.close();
          },
        }),
      ),
    );
  });
  assert.equal((await good.getItems(["B000000001"])).tag, "ok");
  const stalledController = new AbortController();
  let stalledCancelled = false;
  const stalled = createAmazonClient(settings, (input) => {
    if (new URL(input instanceof Request ? input.url : input).hostname === "api.amazon.co.jp") {
      return Promise.resolve(token());
    }
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            queueMicrotask(() => {
              stalledController.abort();
            });
          },
          cancel() {
            stalledCancelled = true;
          },
        }),
      ),
    );
  });
  assert.deepEqual(await stalled.getItems(["B000000001"], stalledController.signal), {
    tag: "err",
    error: { code: "provider_unavailable" },
  });
  assert.equal(stalledCancelled, true);
});
