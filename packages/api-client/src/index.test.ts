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
