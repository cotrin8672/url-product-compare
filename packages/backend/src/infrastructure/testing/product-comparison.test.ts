import assert from "node:assert/strict";
import { test } from "node:test";

import { compareProductListings } from "../../comparison/product-comparison.js";

const first = {
  listingId: "shop:first",
  identityVerified: true,
  tax: "included",
  price: { minimum: 2000, maximum: 2000 },
  specifications: { maxPowerW: 65, weightG: 100, warrantyMonths: 12 },
} as const;
const second = {
  ...first,
  listingId: "shop:second",
  price: { minimum: 4000, maximum: 4000 },
  specifications: { maxPowerW: 100, weightG: 200, warrantyMonths: 24 },
};

await test("comparison modes use factual values, equal weights and consistent ties", () => {
  const price = compareProductListings([second, first], "price");
  assert.equal(price.status, "ranked");
  assert.deepEqual(
    price.products.map((entry) => [entry.listingId, entry.rank, entry.recommendationPercent]),
    [
      ["shop:first", 1, 100],
      ["shop:second", 2, 50],
    ],
  );
  assert.equal(
    compareProductListings([first, second], "performance").products[0]?.listingId,
    "shop:second",
  );
  const close = compareProductListings(
    [first, { ...first, listingId: "shop:close", price: { minimum: 2001, maximum: 2001 } }],
    "price",
  );
  assert.deepEqual(
    close.products.map((entry) => [entry.rank, entry.recommendationPercent]),
    [
      [1, 100],
      [2, 100],
    ],
  );
  assert.deepEqual(
    compareProductListings([first, { ...first, listingId: "shop:tie" }], "ai").products.map(
      (entry) => entry.rank,
    ),
    [1, 1],
  );
});

await test("missing identity or a selected specification withholds all ranks without imputing zero", () => {
  for (const candidate of [
    { ...second, identityVerified: false },
    { ...second, specifications: { ...second.specifications, weightG: null } },
  ]) {
    const result = compareProductListings([first, candidate], "ai");
    assert.equal(result.status, "needs_information");
    assert.ok(
      result.products.every((entry) => entry.rank === null && entry.recommendationPercent === null),
    );
  }
  assert.equal(
    compareProductListings(
      [first, { ...second, specifications: { ...second.specifications, weightG: null } }],
      "price",
    ).status,
    "ranked",
  );
  assert.equal(
    compareProductListings([first, { ...second, price: { minimum: 3000, maximum: 4000 } }], "price")
      .status,
    "needs_information",
  );
  assert.equal(compareProductListings([first], "ai").status, "needs_information");
  assert.equal(compareProductListings([], "price").status, "no_match");
});
