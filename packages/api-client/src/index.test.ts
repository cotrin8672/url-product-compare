import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInvestigation } from "./index.js";

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
    observedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:15:00.000Z",
    price: { minimum: 1000, maximum: 2000, currency: "JPY" },
    tax: "included",
    shipping: "excluded",
    availability: "available",
  };
  assert.equal(parseInvestigation({ tag: "ok", value }).productId, null);
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
