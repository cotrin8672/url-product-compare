import assert from "node:assert/strict";
import { test } from "node:test";

import { compareSecurities, parseSecuritiesRequest } from "../../comparison/securities.js";
import type { SecuritiesBroker, SecuritiesRequest } from "../../comparison/securities.js";

const now = "2026-10-25T01:00:00.000Z";
const fund: SecuritiesRequest = {
  mode: "fund",
  monthlyYen: 100_000,
  monthlyShoppingYen: 50_000,
  annualShoppingYen: 100_000,
  rakutenFundBand: "low",
};
const stocks: SecuritiesRequest = {
  mode: "stock",
  account: "taxable",
  tradeYen: 100_000,
  orders: 3,
  sbiElectronicDelivery: true,
  rakutenZeroCourse: true,
};
const brokers: readonly SecuritiesBroker[] = ["sbi", "rakuten", "monex"].flatMap((id) => {
  if (id !== "sbi" && id !== "rakuten" && id !== "monex") {
    return [];
  }
  return [
    {
      id,
      name: id,
      officialUrl: "https://example.test/",
      checkedAt: "2026-10-25T00:00:00.000Z",
      reviewAfter: "2026-10-26T00:00:00.000Z",
      pointsFrom: "2026-10-01T00:00:00.000Z",
      card: "standard",
      minimumCardYen: id === "monex" ? 1000 : 100,
      pointName: "points",
      sources: [],
      notes: [],
      stockFees: [
        { throughYen: 50_000, feeYen: 55 },
        { throughYen: 100_000, feeYen: 99 },
        { throughYen: 200_000, feeYen: 115 },
      ],
    },
  ];
});

await test("securities request rejects extra fields, fractional, missing, oversized and nonfinite inputs", () => {
  for (const input of [
    null,
    {},
    { ...fund, extra: true },
    { ...fund, monthlyYen: 99 },
    { ...fund, monthlyYen: 100_001 },
    { ...fund, monthlyYen: NaN },
    { ...fund, annualShoppingYen: -1 },
    { ...fund, monthlyShoppingYen: 0.5 },
    { ...fund, rakutenFundBand: "guessed" },
    { ...stocks, orders: 0 },
    { ...stocks, orders: 1.1 },
    { ...stocks, account: "margin" },
  ]) {
    assert.equal(parseSecuritiesRequest(input).tag, "err");
  }
  assert.equal(parseSecuritiesRequest(fund).tag, "ok");
  assert.equal(parseSecuritiesRequest(stocks).tag, "ok");
});

await test("securities applies marginal Monex bands and exact spending thresholds without ranking point currencies", () => {
  for (const [spend, expected] of [
    [9999, 0],
    [10000, 365],
    [49999, 365],
    [50000, 730],
  ]) {
    const result = compareSecurities(brokers, { ...fund, monthlyShoppingYen: spend }, now);
    assert.equal(result.tag, "ok");
    assert.equal(result.value.rows.find((row) => row.id === "monex")?.value, expected);
    assert.ok(result.value.rows.every((row) => row.rank === null));
    assert.equal(result.value.rows.find((row) => row.id === "sbi")?.value, 500);
    assert.equal(result.value.rows.find((row) => row.id === "rakuten")?.value, 500);
  }
  for (const [amount, expected] of [
    [50000, 550],
    [50001, 550.006],
    [70000, 670],
    [70001, 670.002],
  ]) {
    const result = compareSecurities(brokers, { ...fund, monthlyYen: amount }, now);
    if (result.tag !== "ok") {
      throw new Error("Expected comparison");
    }
    assert.equal(result.value.rows.find((row) => row.id === "monex")?.value, expected);
  }
});

await test("securities separates unknown rate, below minimum and actual zero-point eligibility", () => {
  const result = compareSecurities(
    brokers,
    { ...fund, monthlyYen: 100, annualShoppingYen: 99999, rakutenFundBand: "unknown" },
    now,
  );
  if (result.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.equal(result.value.rows.find((row) => row.id === "sbi")?.value, 0);
  assert.equal(result.value.rows.find((row) => row.id === "rakuten")?.status, "needs_information");
  assert.equal(result.value.rows.find((row) => row.id === "monex")?.status, "out_of_scope");
  const high = compareSecurities(brokers, { ...fund, rakutenFundBand: "high" }, now);
  if (high.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.equal(high.value.rows.find((row) => row.id === "rakuten")?.value, 1000);
});

await test("securities stock fees fence prerequisites, fee boundaries, NISA and tied ranks", () => {
  const result = compareSecurities(brokers, stocks, now);
  if (result.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.deepEqual(
    result.value.rows.map((row) => [row.value, row.rank]),
    [
      [0, 1],
      [0, 1],
      [297, 3],
    ],
  );
  for (const [amount, fee] of [
    [50000, 55],
    [50001, 99],
    [100000, 99],
    [100001, 115],
  ]) {
    const boundary = compareSecurities(brokers, { ...stocks, tradeYen: amount, orders: 1 }, now);
    if (boundary.tag !== "ok") {
      throw new Error("Expected comparison");
    }
    assert.equal(boundary.value.rows.find((row) => row.id === "monex")?.value, fee);
  }
  const nisa = compareSecurities(
    brokers,
    { ...stocks, account: "nisa", sbiElectronicDelivery: false, rakutenZeroCourse: false },
    now,
  );
  if (nisa.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.deepEqual(
    nisa.value.rows.map((row) => row.value),
    [null, 0, 0],
  );
  const missing = compareSecurities(
    brokers,
    { ...stocks, sbiElectronicDelivery: false, rakutenZeroCourse: false },
    now,
  );
  if (missing.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.deepEqual(
    missing.value.rows.map((row) => row.rank),
    [null, null, null],
  );
});

await test("securities keeps reference facts but withholds calculations at review deadline and before applicability", () => {
  const stale = compareSecurities(brokers, fund, "2026-10-26T00:00:00.000Z");
  if (stale.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.ok(stale.value.rows.every((row) => row.value === null && row.status === "review_due"));
  assert.equal(stale.value.rows.length, 3);
  const future = compareSecurities(brokers, fund, "2026-09-30T00:00:00.000Z");
  if (future.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.ok(future.value.rows.every((row) => row.value === null));
});

await test("securities expired affiliate falls back to official URL and never changes computed results", () => {
  const result = compareSecurities(brokers, stocks, now, [
    {
      brokerId: "sbi",
      provider: "accesstrade",
      programId: "test",
      url: "https://h.accesstrade.net/sp/cc?rk=test",
      approvedUntil: now,
      creative: { text: "承認済み広告テキスト", impressionUrl: null },
    },
  ]);
  if (result.tag !== "ok") {
    throw new Error("Expected comparison");
  }
  assert.equal(result.value.rows[0]?.link.provider, "official");
  assert.equal(result.value.rows[0].value, 0);
});
