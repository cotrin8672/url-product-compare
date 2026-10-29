import assert from "node:assert/strict";
import { test } from "node:test";

import { createRakutenClient } from "./index.js";

function configuration(): Parameters<typeof createRakutenClient>[0] {
  return {
    applicationId: "test-application",
    accessKey: "test-access-key-1234567890",
    affiliateId: "aaaaaaaa.bbbbbbbb.cccccccc.dddddddd",
    allowedOrigin: "https://compare.example",
  };
}

await test("standalone Rakuten client encodes official parameters, uses accessKey header and accepts documented lower-case items", async () => {
  const settings = configuration();
  const client = createRakutenClient(settings, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://openapi.rakuten.co.jp");
    assert.equal(url.pathname, "/ichibams/api/IchibaItem/Search/20260701");
    assert.equal(url.searchParams.get("applicationId"), settings.applicationId);
    assert.equal(url.searchParams.has("accessKey"), false);
    assert.equal(new Headers(init?.headers).get("accessKey"), settings.accessKey);
    assert.equal(new Headers(init?.headers).get("Origin"), settings.allowedOrigin);
    assert.equal(url.searchParams.get("keyword"), "ふるさと納税 米 & 肉");
    assert.equal(url.searchParams.get("NGKeyword"), "中古");
    assert.equal(url.searchParams.get("elements"), "count,itemName,itemCaption");
    assert.equal(init?.redirect, "error");
    return Promise.resolve(
      Response.json({ count: 1, items: [{ itemName: "米", itemCaption: "5kg×2袋" }] }),
    );
  });
  const result = await client.searchItems({
    keyword: "ふるさと納税 米 & 肉",
    hits: 1,
    elements: ["count", "itemName", "itemCaption"],
    excludeKeyword: "中古",
  });
  assert.equal(result.tag, "ok");
  assert.equal(result.value.items[0]?.["itemCaption"], "5kg×2袋");
});

await test("Rakuten affiliate lookup returns only the exact item's API-issued link with our attribution", async () => {
  const settings = configuration();
  const destination = "https://item.rakuten.co.jp/testshop/item/";
  const link =
    "https://hb.afl.rakuten.co.jp/hgc/" +
    settings.affiliateId +
    "/?pc=" +
    encodeURIComponent(destination);
  for (const returned of [
    link,
    link.replace(settings.affiliateId, "11111111.22222222.33333333.44444444"),
  ]) {
    const client = createRakutenClient(settings, (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.searchParams.get("itemCode"), "testshop:item");
      assert.equal(url.searchParams.get("hits"), "1");
      return Promise.resolve(
        Response.json({
          count: 1,
          items: [{ itemCode: "testshop:item", itemUrl: destination, affiliateUrl: returned }],
        }),
      );
    });
    const result = await client.getAffiliateLink("testshop:item");
    assert.equal(result.tag, returned === link ? "ok" : "err");
    if (result.tag === "ok") {
      assert.equal(result.value, link);
    }
  }
});

await test("Rakuten operations share pacing and expose genre and product payloads without backend types", async () => {
  const settings = configuration();
  const starts: number[] = [];
  const fetcher: typeof fetch = (input) => {
    starts.push(Date.now());
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("IchibaGenre")) {
      return Promise.resolve(
        Response.json({
          genre: { genreId: "100227", nameJa: "食品" },
          ancestors: [],
          attributes: [],
        }),
      );
    }
    assert.equal(url.pathname, "/ichibaproduct/api/Product/Search/20250801");
    assert.equal(url.searchParams.get("productCode"), "4900000000000");
    assert.equal(url.searchParams.has("hits"), false);
    return Promise.resolve(Response.json({ Products: [{ Product: { productName: "製品" } }] }));
  };
  const client = createRakutenClient(settings, fetcher);
  assert.equal(createRakutenClient(settings, fetcher), client);
  const genre = await client.genre("100227");
  assert.equal(genre.tag, "ok");
  const products = await client.searchProducts({ productCode: "4900000000000" });
  assert.equal(products.tag, "ok");
  assert.equal(products.value.length, 1);
  assert.equal(starts.length, 2);
  assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 1000);
});

await test("Rakuten rejects invalid requests without effects and bounds vendor response containers", async () => {
  let calls = 0;
  const client = createRakutenClient(configuration(), () => {
    calls += 1;
    return Promise.resolve(Response.json({ count: 0 }));
  });
  for (const query of [
    {},
    { keyword: "米".repeat(44) },
    { keyword: "米", page: 101 },
    { keyword: "米", hits: 31 },
    { itemCode: "wrong" },
  ]) {
    assert.equal((await client.searchItems(query)).tag, "err");
  }
  assert.equal((await client.genre("https://evil.example")).tag, "err");
  assert.equal((await client.searchProducts({ productCode: "not-a-jan" })).tag, "err");
  assert.equal(
    (await client.searchProducts({ productCode: "4900000000000", keyword: "米" })).tag,
    "err",
  );
  assert.equal(calls, 0);
  assert.throws(() => createRakutenClient({ ...configuration(), applicationId: "x" }));
  const malformed = await createRakutenClient(configuration(), () =>
    Promise.resolve(new Response("{")),
  ).searchItems({ keyword: "米" });
  assert.equal(malformed.tag, "err");
  assert.equal(malformed.error.code, "invalid_json");
  for (const body of [
    { count: "1", Items: [] },
    { count: 1, Items: [null] },
    { count: 1, Items: [{}], items: [{}] },
    { count: 1, Items: [{}, {}] },
  ]) {
    const result = await createRakutenClient(configuration(), () =>
      Promise.resolve(Response.json(body)),
    ).searchItems({ keyword: "米", hits: 1 });
    assert.equal(result.tag, "err");
    assert.equal(result.error.code, "invalid_response");
  }
});

await test("Rakuten distinguishes rejected search parameters from a provider outage", async () => {
  let calls = 0;
  const client = createRakutenClient(configuration(), () => {
    calls += 1;
    return Promise.resolve(
      Response.json(
        { error: "wrong_parameter", error_description: "itemCode is not valid" },
        { status: 400 },
      ),
    );
  });
  const result = await client.searchItems({ itemCode: "testshop:4901201157554" });
  assert.equal(result.tag, "err");
  assert.equal(result.error.code, "invalid_request");
  assert.equal(calls, 1);
});

await test("Rakuten retries transient transport failures once but never retries authorization or rate rejection", async () => {
  let calls = 0;
  const client = createRakutenClient(configuration(), () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("private access key"))
      : Promise.resolve(Response.json({ count: 0, Items: [] }));
  });
  assert.equal((await client.searchItems({ keyword: "米" })).tag, "ok");
  assert.equal(calls, 2);
  for (const status of [401, 403, 429]) {
    let requests = 0;
    const result = await createRakutenClient(configuration(), () => {
      requests += 1;
      return Promise.resolve(new Response("private access key", { status }));
    }).searchItems({ keyword: "米" });
    assert.equal(result.tag, "err");
    assert.equal(
      result.error.code,
      status === 429 ? "provider_rate_limited" : "provider_unauthorized",
    );
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

await test("Rakuten streaming limits cancel excess data and aborts release stalled response bodies", async () => {
  let cancelled = false;
  const result = await createRakutenClient(configuration(), () =>
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
  ).searchItems({ keyword: "米" });
  assert.equal(result.tag, "err");
  assert.equal(result.error.code, "invalid_response_size");
  assert.equal(cancelled, true);
  const controller = new AbortController();
  let enter: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let released = false;
  const pending = createRakutenClient(configuration(), () => {
    enter?.();
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            released = true;
          },
        }),
      ),
    );
  }).searchItems({ keyword: "米" }, controller.signal);
  await entered;
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.tag, "err");
  assert.equal(released, true);
});
