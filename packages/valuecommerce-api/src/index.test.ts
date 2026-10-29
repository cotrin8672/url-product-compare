import assert from "node:assert/strict";
import { test } from "node:test";

import { createSatofullClient, createValueCommerceClient } from "./index.js";

function item(ecCode = "jbfh4"): Readonly<Record<string, unknown>> {
  return {
    ecCode,
    productCode: "vc-item-id",
    title: "白米10kg",
    description: "内容量:5kg×2袋",
    imageLarge: { url: "https://www.satofull.jp/upload/rice-large.jpg", width: 300, height: 300 },
    guid: "https://www.satofull.jp/products/detail.php?product_id=1234",
    link: "https://ck.jp.ap.valuecommerce.com/servlet/referral",
    price: "20000",
    stock: "2",
  };
}

await test("Satofull client pins its advertiser and preserves the distinct API product ID and page URL", async () => {
  const seen: URL[] = [];
  const client = createSatofullClient({ token: "test-token" }, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    assert.equal(url.origin, "https://webservice.valuecommerce.ne.jp");
    assert.equal(url.pathname, "/productdb/search");
    assert.equal(url.searchParams.get("ec_code"), "jbfh4");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(init?.redirect, "error");
    return Promise.resolve(Response.json({ status: "OK", resultCount: 1, items: [item()] }));
  });
  const search = await client.request({ operation: "search", query: "米 & 肉", limit: 1 });
  assert.equal(search.tag, "ok");
  assert.equal(search.value.items[0]?.productCode, "vc-item-id");
  assert.equal(search.value.items[0].price, 20000);
  assert.equal(search.value.items[0].stock, 2);
  assert.equal(search.value.items[0].imageUrl, "https://www.satofull.jp/upload/rice-large.jpg");
  assert.equal(seen[0]?.searchParams.get("keyword"), "米 & 肉");
  assert.equal(
    (await client.request({ operation: "lookup", query: "vc-item-id", limit: 1 })).tag,
    "ok",
  );
  assert.equal(seen[1]?.searchParams.get("product_id"), "vc-item-id");
  assert.equal(seen[1].searchParams.has("keyword"), false);
});

await test("ValueCommerce affiliate lookup verifies product identity and the API-issued redirect destination", async () => {
  const destination = "https://www.satofull.jp/products/detail.php?product_id=1234";
  const link =
    "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1234567&pid=123456789&vc_url=" +
    encodeURIComponent(destination);
  for (const patch of [
    { link },
    { link, productCode: "other" },
    { link: link.replace("vc_url=", "other=") },
  ]) {
    const client = createSatofullClient({ token: "test-token" }, (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.searchParams.get("product_id"), "vc-item-id");
      assert.equal(url.searchParams.get("results_per_page"), "1");
      return Promise.resolve(
        Response.json({ status: "OK", resultCount: 1, items: [{ ...item(), ...patch }] }),
      );
    });
    const result = await client.getAffiliateLink("vc-item-id");
    assert.equal(result.tag, "productCode" in patch || patch.link !== link ? "err" : "ok");
    if (result.tag === "ok") {
      assert.equal(result.value, link);
    }
  }
});

await test("ValueCommerce uses the documented image objects and drops unsafe or missing image URLs", async () => {
  for (const entry of [
    {
      imageLarge: { url: "javascript:alert(1)" },
      imageSmall: { url: "https://www.satofull.jp/upload/small.jpg" },
      expected: "https://www.satofull.jp/upload/small.jpg",
    },
    { imageLarge: { url: "https://127.0.0.1/private" }, expected: null },
    { imageLarge: { url: "http://www.satofull.jp/upload/rice.jpg" }, expected: null },
    { imageLarge: { url: "https://user:secret@www.satofull.jp/upload/rice.jpg" }, expected: null },
    { imageLarge: undefined, expected: null },
  ]) {
    const response = await createSatofullClient({ token: "test-token" }, () =>
      Promise.resolve(
        Response.json({ status: "OK", resultCount: 1, items: [{ ...item(), ...entry }] }),
      ),
    ).request({ operation: "search", query: "米" });
    assert.equal(response.tag, "ok");
    assert.equal(response.value.items[0]?.imageUrl, entry.expected);
  }
});

await test("ValueCommerce can be reused for Yahoo without importing any application comparison types", async () => {
  const result = await createValueCommerceClient(
    { token: "test-token", advertiserCode: "0hzmc" },
    (input) => {
      assert.equal(
        new URL(input instanceof Request ? input.url : input).searchParams.get("ec_code"),
        "0hzmc",
      );
      return Promise.resolve(
        Response.json({
          status: "OK",
          resultCount: 1,
          items: [{ ...item("0hzmc"), stock: undefined, description: null }],
        }),
      );
    },
  ).request({ operation: "search", query: "商品" });
  assert.equal(result.tag, "ok");
  assert.equal(result.value.items[0]?.stock, null);
  assert.equal(result.value.items[0].description, null);
});

await test("ValueCommerce interprets documented stock values and leaves unknown values unset", async () => {
  for (const [stock, expected] of [
    ["なし", 0],
    ["在庫有り", 1],
    ["お取り寄せ", 2],
    ["予約受付", 3],
    ["1", 1],
    ["", null],
    ["不明", null],
  ]) {
    const result = await createSatofullClient({ token: "test-token" }, () =>
      Promise.resolve(
        Response.json({ status: "OK", resultCount: 1, items: [{ ...item(), stock }] }),
      ),
    ).request({ operation: "search", query: "米" });
    assert.equal(result.tag, "ok");
    assert.equal(result.value.items[0]?.stock, expected);
  }
});

await test("ValueCommerce validates documented parameters and merchant responses and sanitizes upstream failures", async () => {
  let calls = 0;
  const client = createSatofullClient({ token: "test-token" }, () => {
    calls += 1;
    return Promise.resolve(Response.json({ status: "OK", resultCount: 0, items: [] }));
  });
  for (const query of [
    { operation: "search", query: "" },
    { operation: "search", query: "x".repeat(257) },
    { operation: "search", query: "米", page: 1001 },
    { operation: "search", query: "米", limit: 51 },
    { operation: "lookup", query: "1", page: 2 },
  ] satisfies ReadonlyArray<Parameters<typeof client.request>[0]>) {
    assert.equal((await client.request(query)).tag, "err");
  }
  assert.equal(calls, 0);
  assert.throws(() =>
    createValueCommerceClient({ token: "private token", advertiserCode: "jbfh4" }),
  );
  for (const patch of [
    { ecCode: "0hzmc" },
    { price: "NaN" },
    { description: "x".repeat(4097) },
    { title: "x".repeat(257) },
  ]) {
    const result = await createSatofullClient({ token: "test-token" }, () =>
      Promise.resolve(
        Response.json({ status: "OK", resultCount: 1, items: [{ ...item(), ...patch }] }),
      ),
    ).request({ operation: "search", query: "米" });
    assert.equal(result.tag, "err");
    assert.equal(result.error.code, "invalid_response");
  }
  for (const [status, expected] of [
    ["INVALID_TOKEN", "provider_unauthorized"],
    ["INVALID_CONFIGURATION", "not_configured"],
    ["INVALID_SEARCH_PARAMETERS", "invalid_request"],
    ["INVALID_SEARCH_VALUE", "invalid_request"],
    ["SERVICE_UNAVAILABLE", "provider_unavailable"],
    ["INTERNAL_SERVER_ERROR", "provider_unavailable"],
  ]) {
    const result = await createSatofullClient({ token: "test-token" }, () =>
      Promise.resolve(Response.json({ status })),
    ).request({ operation: "search", query: "米" });
    assert.equal(result.tag, "err");
    assert.equal(result.error.code, expected);
  }
  const failure = await createSatofullClient({ token: "test-token" }, () =>
    Promise.reject(new Error("token=private")),
  ).request({ operation: "search", query: "米" });
  assert.equal(failure.tag, "err");
  assert.equal(JSON.stringify(failure).includes("private"), false);
});

await test("ValueCommerce limits response bytes and honors cancellation without leaking transport errors", async () => {
  let cancelled = false;
  const result = await createSatofullClient({ token: "test-token" }, () =>
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
  ).request({ operation: "search", query: "米" });
  assert.equal(result.tag, "err");
  assert.equal(result.error.code, "invalid_response");
  assert.equal(cancelled, true);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.equal(
    (
      await createSatofullClient({ token: "test-token" }, () => {
        calls += 1;
        return Promise.reject(new Error("Never fetch"));
      }).request({ operation: "search", query: "米" }, controller.signal)
    ).tag,
    "err",
  );
  assert.equal(calls, 0);
});
