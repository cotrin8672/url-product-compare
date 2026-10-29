import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createYahooAffiliateId, createYahooShoppingClient } from "./index.js";

const settings = {
  applicationId: "test-application-id",
  affiliateId: createYahooAffiliateId({ siteId: "1234567", spaceId: "123456789" }),
};
const destination = "https://store.shopping.yahoo.co.jp/testshop/item-1.html";
const affiliate =
  "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1234567&pid=123456789&vc_url=" +
  encodeURIComponent(destination);
function hit(): Readonly<Record<string, unknown>> {
  return {
    code: "testshop_item-1",
    name: "検証商品",
    description: "容量: 1L",
    url: affiliate,
    price: 12000,
    inStock: true,
    condition: "new",
    shipping: { code: 2 },
    priceLabel: { taxable: true },
    exImage: { url: "https://item-shopping.c.yimg.jp/i/n/testshop_item-1" },
  };
}
function search(items: readonly unknown[] = [hit()], start = 1): Response {
  return Response.json({
    totalResultsAvailable: items.length,
    totalResultsReturned: items.length,
    firstResultsPosition: start,
    hits: items,
  });
}
function lookup(patch = ""): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><ResultSet totalResultsReturned="1"><Result><Hit index="1">' +
    "<Code>testshop_item-1</Code><Name>検証 &amp; 商品</Name><Url>" +
    affiliate.replaceAll("&", "&amp;") +
    '</Url><Price currency="JPY">12000</Price><PriceLabel taxIncluded="true"/><Availability>instock</Availability>' +
    "<Caption><![CDATA[容量: 1L<br>本体]]></Caption><Shipping><Code>2</Code></Shipping>" +
    "<ExImage><Url>https://item-shopping.c.yimg.jp/i/n/testshop_item-1</Url></ExImage>" +
    patch +
    "</Hit></Result></ResultSet>"
  );
}

await test("Yahoo standalone search uses the documented v3 fields, pagination, JAN and VC affiliate parameters", async () => {
  const client = createYahooShoppingClient(settings, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://shopping.yahooapis.jp");
    assert.equal(url.pathname, "/ShoppingWebService/V3/itemSearch");
    assert.equal(url.searchParams.get("appid"), settings.applicationId);
    assert.equal(url.searchParams.get("affiliate_type"), "vc");
    assert.equal(url.searchParams.get("affiliate_id"), settings.affiliateId);
    assert.ok(url.href.includes("affiliate_id=https%3A%2F%2F"));
    assert.equal(url.href.includes("affiliate_id=https%253A"), false);
    assert.equal(url.searchParams.get("query"), "保温 ボトル");
    assert.equal(url.searchParams.get("start"), "6");
    assert.equal(url.searchParams.get("results"), "5");
    assert.equal(url.searchParams.get("jan_code"), "4901234567890");
    assert.equal(url.searchParams.get("condition"), "new");
    assert.equal(init?.redirect, "error");
    return Promise.resolve(search([hit()], 6));
  });
  const result = await client.request({
    operation: "search",
    query: "保温 ボトル",
    page: 2,
    limit: 5,
    janCode: "4901234567890",
    condition: "new",
  });
  assert.ok(result.tag === "ok");
  assert.equal(result.value.items[0]?.url, destination);
  assert.equal(result.value.items[0].affiliateUrl, affiliate);
  assert.equal(result.value.items[0].condition, "new");
  assert.equal(result.value.items[0].shippingCode, 2);
  assert.equal(result.value.items[0].taxIncluded, true);
});

await test("Yahoo exact lookup parses the documented XML and returns the API-issued link without fabricating condition", async () => {
  const client = createYahooShoppingClient(settings, (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/ShoppingWebService/V1/itemLookup");
    assert.equal(url.searchParams.get("itemcode"), "testshop_item-1");
    assert.equal(url.searchParams.get("responsegroup"), "large");
    assert.equal(url.searchParams.has("callback"), false);
    return Promise.resolve(new Response(lookup()));
  });
  const result = await client.request({ operation: "lookup", query: "testshop_item-1" });
  assert.ok(result.tag === "ok");
  assert.equal(result.value.items[0]?.name, "検証 & 商品");
  assert.equal(result.value.items[0].description, "容量: 1L<br>本体");
  assert.equal(result.value.items[0].inStock, true);
  assert.equal(result.value.items[0].condition, "unknown");
  assert.deepEqual(await client.getAffiliateLink("testshop_item-1"), {
    tag: "ok",
    value: affiliate,
  });
});

await test("Yahoo rejects malformed input before networking and treats non-affiliate catalog use explicitly", async () => {
  let calls = 0;
  const client = createYahooShoppingClient(settings, () => {
    calls++;
    throw new Error("Must not call");
  });
  for (const query of [
    { operation: "search", query: "" },
    { operation: "search", query: "x", page: 21, limit: 50 },
    { operation: "lookup", query: "not-a-code" },
    { operation: "lookup", query: "testshop_item-1", page: 2 },
    { operation: "search", query: "x", janCode: "broken" },
  ] satisfies Array<Parameters<typeof client.request>[0]>) {
    assert.deepEqual(await client.request(query), {
      tag: "err",
      error: { code: "invalid_request" },
    });
  }
  assert.equal(calls, 0);
  assert.throws(() =>
    createYahooShoppingClient({
      ...settings,
      affiliateId: encodeURIComponent(settings.affiliateId),
    }),
  );
  assert.throws(() => createYahooAffiliateId({ siteId: "bad", spaceId: "123456789" }));
  const plain = createYahooShoppingClient({ applicationId: settings.applicationId }, (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.searchParams.has("affiliate_id"), false);
    return Promise.resolve(search([{ ...hit(), url: destination }]));
  });
  const response = await plain.request({ operation: "search", query: "x" });
  assert.ok(response.tag === "ok" && response.value.items[0]?.affiliateUrl === null);
  assert.deepEqual(await plain.getAffiliateLink("testshop_item-1"), {
    tag: "err",
    error: { code: "invalid_request" },
  });
});

await test("Yahoo refuses changed identities, executable links and affiliate destination mismatches", async () => {
  for (const patch of [
    { code: "testshop_other" },
    { url: affiliate.replace("sid=1234567", "sid=9999999") },
    { url: "javascript:alert(1)" },
    { url: destination },
    { url: affiliate + "&vc_url=" + encodeURIComponent(destination) },
    { price: -1 },
    {
      url: affiliate.replace(
        "ck.jp.ap.valuecommerce.com",
        "ck.jp.ap.valuecommerce.com.evil.invalid",
      ),
    },
    {
      url: affiliate.replace(
        encodeURIComponent(destination),
        encodeURIComponent("https://evil.invalid/item.html"),
      ),
    },
  ]) {
    const client = createYahooShoppingClient(settings, () =>
      Promise.resolve(search([{ ...hit(), ...patch }])),
    );
    assert.deepEqual(await client.request({ operation: "search", query: "x" }), {
      tag: "err",
      error: { code: "invalid_response" },
    });
  }
  const empty = createYahooShoppingClient(settings, () =>
    Promise.resolve(new Response('<ResultSet totalResultsReturned="0"><Result/></ResultSet>')),
  );
  assert.deepEqual(await empty.request({ operation: "lookup", query: "testshop_item-1" }), {
    tag: "err",
    error: { code: "listing_not_found" },
  });
});

await test("Yahoo XML refuses DTD, external entities, duplicate fields, mismatched tags and changed item codes", async () => {
  for (const xml of [
    '<!DOCTYPE ResultSet [<!ENTITY secret SYSTEM "file:///C:/secret">]>' + lookup(),
    lookup().replace("検証 &amp; 商品", "&unknown;"),
    lookup().replace("検証 &amp; 商品", "&__proto__;"),
    lookup().replace("testshop_item-1</Code>", "testshop_other</Code>"),
    lookup("<Price currency='JPY'>1</Price>"),
    lookup().replace("</Hit>", "</Other>"),
    lookup().replace(
      'totalResultsReturned="1"',
      'totalResultsReturned="1" totalResultsReturned="0"',
    ),
    lookup() + "<extra/>",
  ]) {
    const client = createYahooShoppingClient(settings, () => Promise.resolve(new Response(xml)));
    assert.deepEqual(await client.request({ operation: "lookup", query: "testshop_item-1" }), {
      tag: "err",
      error: { code: "invalid_response" },
    });
  }
});

await test("Yahoo bounds response streams, preserves UTF-8 and aborts queued or stalled requests", async () => {
  let cancelled = false;
  const large = createYahooShoppingClient(settings, () =>
    Promise.resolve(
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
    ),
  );
  assert.deepEqual(await large.request({ operation: "search", query: "x" }), {
    tag: "err",
    error: { code: "invalid_response" },
  });
  assert.equal(cancelled, true);
  let calls = 0;
  const client = createYahooShoppingClient(settings, () => {
    calls++;
    return Promise.resolve(search());
  });
  await client.request({ operation: "search", query: "x" });
  const controller = new AbortController();
  const queued = client.request({ operation: "search", query: "x" }, controller.signal);
  controller.abort();
  assert.deepEqual(await queued, { tag: "err", error: { code: "provider_unavailable" } });
  assert.equal(calls, 1);
  const split = createYahooShoppingClient(settings, () => {
    const bytes = new TextEncoder().encode(lookup());
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
  assert.equal((await split.request({ operation: "lookup", query: "testshop_item-1" })).tag, "ok");
  const denied = createYahooShoppingClient(settings, () =>
    Promise.resolve(new Response("private", { status: 429 })),
  );
  assert.deepEqual(await denied.request({ operation: "search", query: "x" }), {
    tag: "err",
    error: { code: "provider_rate_limited" },
  });
  const stalledController = new AbortController();
  let stalledCancelled = false;
  const stalled = createYahooShoppingClient(settings, () =>
    Promise.resolve(
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
    ),
  );
  assert.deepEqual(
    await stalled.request({ operation: "search", query: "x" }, stalledController.signal),
    { tag: "err", error: { code: "provider_unavailable" } },
  );
  assert.equal(stalledCancelled, true);
});
