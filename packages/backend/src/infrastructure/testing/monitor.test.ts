import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareMonitorListings,
  monitorConditionsSchema,
  readMonitorSpecifications,
} from "../../comparison/monitor.js";
import type { MonitorConditions } from "../../comparison/monitor.js";

const conditions: MonitorConditions = {
  screenSize: null,
  minResolution: null,
  usbCPowerW: 0,
  heightAdjustable: false,
};
const fullSpecifications =
  "画面サイズ: 27インチ\n解像度: 2560×1440\nリフレッシュレート: 100Hz\nUSB-C給電: 65W\nUSB-C映像入力: 対応\nHDMI端子数: 2\nDisplayPort端子数: 1\n高さ調整: 対応\n保証期間: 3年間";

await test("monitor facts require explicit labels and reject contradictory or inferred capabilities", () => {
  const specs = readMonitorSpecifications(fullSpecifications);
  assert.deepEqual(specs, {
    screenSizeInches: 27,
    resolutionWidthPx: 2560,
    resolutionHeightPx: 1440,
    refreshRateHz: 100,
    usbCPowerW: 65,
    usbCVideo: true,
    hdmiPorts: 2,
    displayPortPorts: 1,
    heightAdjustable: true,
    warrantyMonths: 36,
  });
  const ambiguous = readMonitorSpecifications(
    `${fullSpecifications}\n画面サイズ: 32インチ\n解像度: 3840×2160\nUSB-C給電: 90W\n高さ調整: 非対応`,
  );
  assert.equal(ambiguous.screenSizeInches, null);
  assert.equal(ambiguous.resolutionWidthPx, null);
  assert.equal(ambiguous.resolutionHeightPx, null);
  assert.equal(ambiguous.usbCPowerW, null);
  assert.equal(ambiguous.heightAdjustable, null);
  const unproven = readMonitorSpecifications(
    "27型 4K USB-Cポートあり HDMI 2.1 DisplayPort 1.4 USB-C映像出力: 対応",
  );
  assert.equal(unproven.screenSizeInches, null);
  assert.equal(unproven.resolutionWidthPx, null);
  assert.equal(unproven.usbCVideo, null);
  assert.equal(unproven.usbCPowerW, null);
  assert.equal(unproven.hdmiPorts, null);
  assert.equal(unproven.displayPortPorts, null);
  assert.equal(
    readMonitorSpecifications("高さ調整: 対応なし\nUSB-C映像入力: 対応していません")
      .heightAdjustable,
    null,
  );
  assert.equal(
    readMonitorSpecifications(`${fullSpecifications}\nUSB-C給電: 900W`).usbCPowerW,
    null,
  );
  assert.equal(
    readMonitorSpecifications("高さ調整: 不可\nUSB-C映像入力: 非対応").heightAdjustable,
    false,
  );
});

await test("monitor price ordering retains cheaper suitable products, ties, and the input product", () => {
  const listing = (id: string, price: number) => ({
    listingId: id,
    identityVerified: true,
    tax: "included" as const,
    availability: "available" as const,
    price: { minimum: price, maximum: price },
    monitorSpecifications: readMonitorSpecifications(fullSpecifications),
  });
  const source = listing("source", 40_000);
  const cheap = listing("cheap", 20_000);
  const expensive = listing("expensive", 70_000);
  const tied = listing("tie", 20_000);
  const result = compareMonitorListings([source, expensive, tied, cheap], conditions, "price");
  assert.equal(result.status, "ranked");
  assert.deepEqual(
    result.products.map((product) => [product.listingId, product.rank]),
    [
      ["cheap", 1],
      ["tie", 1],
      ["source", 3],
      ["expensive", 4],
    ],
  );
  assert.equal(
    compareMonitorListings([source, cheap], conditions, "specifications").products.every(
      (product) => product.rank === null,
    ),
    true,
  );
  const mismatched = {
    ...cheap,
    monitorSpecifications: { ...cheap.monitorSpecifications, usbCPowerW: 45 },
  };
  const required: MonitorConditions = {
    ...conditions,
    usbCPowerW: 65,
    heightAdjustable: true,
    minResolution: "qhd",
    screenSize: 27,
  };
  assert.equal(
    compareMonitorListings([{ ...source, availability: "unavailable" }], conditions, "price")
      .status,
    "no_match",
  );
  assert.equal(compareMonitorListings([mismatched], required, "price").status, "no_match");
  const unproven = {
    ...cheap,
    monitorSpecifications: { ...cheap.monitorSpecifications, usbCVideo: null },
  };
  const pending = compareMonitorListings([source, unproven], required, "price");
  assert.equal(pending.status, "needs_information");
  assert.equal(
    pending.products.every((product) => product.rank === null),
    true,
  );
  assert.equal(
    pending.products.find((product) => product.listingId === "cheap")?.status,
    "pending",
  );
  for (const patch of [
    { identityVerified: false },
    { tax: "excluded" as const },
    { price: { minimum: 10_000, maximum: 20_000 } },
  ]) {
    assert.equal(
      compareMonitorListings([source, { ...cheap, ...patch }], conditions, "price").status,
      "needs_information",
    );
  }
});

await test("monitor conditions reject free text, unsupported thresholds, and extra fields", () => {
  assert.equal(monitorConditionsSchema.parse(conditions).tag, "ok");
  for (const input of [
    null,
    {},
    { ...conditions, screenSize: "27" },
    { ...conditions, minResolution: "8k" },
    { ...conditions, usbCPowerW: 60 },
    { ...conditions, heightAdjustable: "true" },
    { ...conditions, notes: "AIで推測" },
  ]) {
    assert.equal(monitorConditionsSchema.parse(input).tag, "err");
  }
});
