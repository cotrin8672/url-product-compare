import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyConsumerChoices,
  assessConsumerListing,
  compareConsumerListings,
  consumerCategories,
  consumerCategory,
  consumerConditionsSchema,
  readConsumerInformation,
} from "../../comparison/consumer.js";
import type { ConsumerInformation } from "../../comparison/consumer.js";

type TestListing = Readonly<{
  listingId: string;
  identityVerified: boolean;
  availability: "available";
  tax: "included";
  price: Readonly<{ minimum: number; maximum: number }>;
  consumerInformation: ConsumerInformation;
  condition: "new";
}>;

const laptop = consumerCategory("laptop");
if (laptop === null) {
  throw new Error("Missing laptop category");
}
const url = "https://item.rakuten.co.jp/shop/product/";

await test("six consumer categories have distinct fields, validated conditions, and no model-name scoring", () => {
  assert.deepEqual(
    consumerCategories.map((category) => category.id),
    ["laptop", "desktop", "tablet", "smartphone", "television", "monitor"],
  );
  assert.equal(consumerCategory("gpu"), null);
  for (const category of consumerCategories) {
    assert.equal(consumerConditionsSchema(category).parse({}).tag, "ok");
    assert.equal(consumerConditionsSchema(category).parse({ invented: 1 }).tag, "err");
    assert.equal(new Set(category.fields.map((field) => field.id)).size, category.fields.length);
    for (const field of category.fields) {
      if (field.filter === "min" || field.filter === "max") {
        assert.equal(
          consumerConditionsSchema(category).parse({ [field.id]: field.minimum }).tag,
          "ok",
        );
        assert.equal(consumerConditionsSchema(category).parse({ [field.id]: Infinity }).tag, "err");
        assert.equal(consumerConditionsSchema(category).parse({ [field.id]: "16" }).tag, "err");
      }
    }
  }
  assert.equal(consumerConditionsSchema(laptop).parse({ cpu: "Core i7" }).tag, "err");
  const fixtures = [
    {
      id: "laptop",
      input:
        "CPU: Core i5-1335U\nOS: Windows 11\nメモリ: 16GB\nSSD: 1TB\n画面サイズ: 14インチ\n解像度: 1920×1200\n重量: 1.25kg\nバッテリー駆動時間: 12時間",
      expected: {
        ramGb: 16,
        storageGb: 1000,
        weightG: 1250,
        cpu: "Core i5-1335U",
        batteryHours: 12,
      },
    },
    {
      id: "desktop",
      input: "RAM: 32GB\nSSD: 512GB\nディスプレイ付属: なし",
      expected: { ramGb: 32, storageGb: 512, displayIncluded: false },
    },
    {
      id: "tablet",
      input: "ストレージ: 128GB\n画面サイズ: 11インチ\nバッテリー容量: 8000mAh\nモバイル通信: 対応",
      expected: { storageGb: 128, screenInches: 11, batteryMah: 8000, cellular: true },
    },
    {
      id: "smartphone",
      input: "保存容量: 256GB\nSIMフリー: 対応\n防水等級: IP68\n本体重量: 180g",
      expected: { storageGb: 256, simFree: true, waterResistance: "IP68", weightG: 180 },
    },
    {
      id: "television",
      input: "画面サイズ: 55型\n解像度: 3840×2160\nHDMI入力数: 3\nネット動画: 対応\nUSB録画: 対応",
      expected: { screenInches: 55, widthPx: 3840, hdmiPorts: 3, smartTv: true, recording: true },
    },
    {
      id: "monitor",
      input: "画面サイズ: 27インチ\nUSB-C給電: 65W\nUSB-C映像入力: 対応\n高さ調整: あり",
      expected: { screenInches: 27, usbCPowerW: 65, usbCVideo: true, heightAdjustable: true },
    },
  ];
  for (const fixture of fixtures) {
    const category = consumerCategory(fixture.id);
    assert.ok(category !== null);
    const information = readConsumerInformation(category, "shop:product", url, fixture.input);
    for (const [field, value] of Object.entries(fixture.expected)) {
      assert.equal(information.specs[field], value, `${fixture.id}.${field}`);
    }
    assert.equal(
      information.facts.every((fact) => fixture.input.includes(fact.quote)),
      true,
    );
  }
});

await test("capacity extraction refuses upgrade limits, VRAM, variants and contradictions", () => {
  const unknown = readConsumerInformation(
    laptop,
    "shop:product",
    url,
    "最大メモリ: 64GB\nVRAM: 8GB\nSSD最大対応: 2TB\nHDMI 2.1\nおすすめメモリ: 32GB",
  );
  assert.equal(unknown.specs["ramGb"], null);
  assert.equal(unknown.specs["storageGb"], null);
  const conflict = readConsumerInformation(
    laptop,
    "shop:product",
    url,
    "メモリ: 8GB\nメモリ: 16GB\nSSD: 512GB",
  );
  assert.equal(conflict.specs["ramGb"], null);
  assert.deepEqual(conflict.conflicts, ["ramGb"]);
  assert.equal(
    conflict.choices.some((choice) => choice.field === "ramGb"),
    false,
  );
  const variants = readConsumerInformation(
    laptop,
    "shop:product",
    url,
    "メモリ: 8GB/16GB\nSSD: 256GB/512GB",
  );
  assert.equal(variants.specs["ramGb"], null);
  assert.equal(variants.specs["storageGb"], null);
  for (const separator of ["", " ", ",", "、", "・", "/"]) {
    const multiple = readConsumerInformation(
      laptop,
      "shop:variants",
      url,
      `メモリ8GB${separator}12GB${separator}16GB${separator}32GB\nSSD256GB${separator}512GB`,
    );
    assert.equal(multiple.specs["ramGb"], null, separator);
    assert.equal(multiple.specs["storageGb"], null, separator);
    assert.deepEqual(multiple.conflicts, ["ramGb", "storageGb"], separator);
    assert.equal(multiple.facts.length, 0, separator);
    assert.equal(multiple.choices.length, 0, separator);
  }
  for (const input of [
    "メモリ16GB SSD512GB",
    "RAM16GB(8GBx2) 記憶装置512GBSSD",
    "RAM16GB(8GB×2) 記憶装置512GBSSD",
  ]) {
    const single = readConsumerInformation(laptop, "shop:single", url, input);
    assert.equal(single.specs["ramGb"], 16, input);
    assert.equal(single.specs["storageGb"], 512, input);
    assert.deepEqual(single.conflicts, [], input);
  }
  const suffix = readConsumerInformation(laptop, "shop:product", url, "RAM: 16Gbps");
  assert.equal(suffix.specs["ramGb"], null);
  const resolutions = readConsumerInformation(
    laptop,
    "shop:product",
    url,
    "解像度: 1920×1080\n解像度: 2560×1080",
  );
  assert.equal(resolutions.specs["widthPx"], null);
  assert.equal(resolutions.specs["heightPx"], null);
  assert.equal(
    resolutions.facts.some((fact) => fact.field === "heightPx"),
    false,
  );
});

await test("PC details retain labeled specifications and score factual quantities without scoring CPU or GPU models", () => {
  const caption =
    "CPU: Intel Core Ultra 7 155H; GPU: NVIDIA GeForce RTX 4060; CPUコア数: 16コア; CPUスレッド数: 22スレッド; GPU補足 VRAM: 8GB; メモリ: 16GB; SSD: 1TB; 重量: 1.4kg; バッテリー時間: 12時間; バッテリー容量: 60Wh; 解像度: 2560×1600; リフレッシュレート: 144Hz; 輝度: 350nit; USB-A端子数: 3個; USB-C端子数: 2個; Wi-Fi: Wi-Fi 6E; Bluetoothバージョン: 5.3; 有線LAN: 対応; 本体幅: 320mm; 本体高さ: 19.5mm; 本体奥行: 220mm; CPU基本周波数: 1.4GHz; CPU最大周波数: 4.8GHz; L3キャッシュ: 24MB; GPU最大周波数: 2.37GHz; GPU消費電力: 115W; メモリ速度: 5600MT/s; HDMI出力端子数: 1個; sRGBカバー率: 100%";
  const expected = {
    cpu: "Intel Core Ultra 7 155H",
    gpu: "NVIDIA GeForce RTX 4060",
    cpuCores: 16,
    cpuThreads: 22,
    gpuVramGb: 8,
    ramGb: 16,
    storageGb: 1000,
    weightG: 1400,
    widthPx: 2560,
    heightPx: 1600,
    refreshHz: 144,
    brightnessNits: 350,
    usbAPorts: 3,
    usbCPorts: 2,
    wifiVersion: "Wi-Fi 6E",
    bluetoothVersion: "5.3",
    wiredLan: true,
    widthMm: 320,
    heightMm: 19.5,
    depthMm: 220,
    cpuBaseGhz: 1.4,
    cpuBoostGhz: 4.8,
    cpuCacheMb: 24,
    gpuBoostMhz: 2370,
    gpuPowerW: 115,
    ramSpeedMtps: 5600,
    hdmiOutputPorts: 1,
    srgbPercent: 100,
  };
  for (const id of ["laptop", "desktop"]) {
    const category = consumerCategory(id);
    assert.ok(category !== null);
    assert.ok(category.mainFields.includes("cpu") && category.mainFields.includes("gpu"));
    assert.ok(category.mainFields.length <= 6);
    const nonPriceAxes = category.axes.filter((axis) => axis.id !== "price");
    assert.equal(nonPriceAxes.length, 22);
    assert.deepEqual(
      nonPriceAxes.slice(0, 6).map((axis) => axis.id),
      id === "laptop"
        ? ["ramGb", "storageGb", "weightG", "batteryHours", "widthPx", "refreshHz"]
        : ["ramGb", "storageGb", "gpuVramGb", "cpuCores", "usbAPorts", "usbCPorts"],
    );
    assert.equal(
      category.axes.some((axis) =>
        ["cpu", "gpu", "wifiVersion", "bluetoothVersion", "wiredLan"].includes(axis.id),
      ),
      false,
    );
    const information = readConsumerInformation(category, "shop:source", url, caption);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(information.specs[field], value, `${id}.${field}`);
      assert.ok(information.facts.some((fact) => fact.field === field && fact.value === value));
    }
    assert.equal(information.specs["batteryHours"], id === "laptop" ? 12 : undefined);
    assert.equal(information.specs["batteryWh"], id === "laptop" ? 60 : undefined);
    assert.deepEqual(information.conflicts, []);
    assert.equal(
      information.facts.every((fact) => caption.includes(fact.quote)),
      true,
    );
    const listing = (listingId: string, price: number): TestListing => ({
      listingId,
      identityVerified: false,
      availability: "available",
      tax: "included",
      price: { minimum: price, maximum: price },
      consumerInformation: information,
      condition: "new",
    });
    const comparison = compareConsumerListings(
      [listing("source", 80000), listing("cheap", 40000)],
      category,
      {},
      "recommendation",
    );
    assert.equal(comparison.status, "ranked");
    assert.deepEqual(
      comparison.products.map((product) => [
        product.listingId,
        product.rank,
        product.recommendationPercent,
      ]),
      [
        ["cheap", 1, 100],
        ["source", 2, 98],
      ],
    );
    assert.equal(
      comparison.products.every((product) =>
        product.axes.filter((axis) => axis.id !== "price").every((axis) => axis.score === 100),
      ),
      true,
    );
  }
});

await test("expanded PC axes score measured quantities, preserve missing slots and refuse model guesses or selectable clocks", () => {
  const realCaption =
    "CPU AMD Ryzen 7 8840HS プロセッサー 3.30GHz (最大ブースト・クロック 5.10GHz) NPU AMD Ryzen AI (最大16TOPS); メモリ 16GB DDR5-5600 SDRAM SODIMM(16GBx1)";
  const actual = readConsumerInformation(laptop, "shop:actual-clocks", url, realCaption);
  assert.equal(actual.specs["cpuBaseGhz"], 3.3);
  assert.equal(actual.specs["cpuBoostGhz"], 5.1);
  assert.equal(actual.specs["ramSpeedMtps"], 5600);
  assert.equal(
    actual.facts.every((fact) => realCaption.includes(fact.quote)),
    true,
  );
  const gpuClock = readConsumerInformation(
    laptop,
    "shop:gpu-clock",
    url,
    "CPU: Intel Core i7 GPU最大周波数: 2GHz; GPU RTX 4060 最大ブーストクロック: 2.5GHz",
  );
  assert.equal(gpuClock.specs["cpuBoostGhz"], null);
  assert.equal(gpuClock.specs["gpuBoostMhz"], 2000);
  const full = readConsumerInformation(
    laptop,
    "shop:fast",
    url,
    "CPU基本周波数: 4GHz; CPU最大周波数: 5GHz; CPUキャッシュ: 32MB; GPUブーストクロック: 2500MHz; TGP: 100W; LPDDR5-6400; HDMI2.1×2; sRGB100%",
  );
  const partial = readConsumerInformation(
    laptop,
    "shop:partial",
    url,
    "CPU基本周波数: 2GHz; CPU最大周波数: 4GHz; L3キャッシュ: 16MB; GPU最大クロック: 2GHz; GPU消費電力: 200W; メモリ速度: 3200MT/s; HDMIポート数: 0個",
  );
  const listing = (listingId: string, information: typeof full): TestListing => ({
    listingId,
    identityVerified: false,
    availability: "available",
    tax: "included",
    price: { minimum: 100000, maximum: 100000 },
    consumerInformation: information,
    condition: "new",
  });
  const result = compareConsumerListings(
    [listing("fast", full), listing("partial", partial)],
    laptop,
    {},
    "recommendation",
  );
  assert.equal(result.status, "ranked");
  const slower = result.products.find((product) => product.listingId === "partial");
  assert.ok(slower !== undefined);
  for (const [id, score] of Object.entries({
    cpuBaseGhz: 50,
    cpuBoostGhz: 80,
    cpuCacheMb: 50,
    gpuBoostMhz: 80,
    gpuPowerW: 50,
    ramSpeedMtps: 50,
    hdmiOutputPorts: 0,
  })) {
    assert.equal(slower.axes.find((axis) => axis.id === id)?.score, score, id);
  }
  assert.equal(
    result.products.every(
      (product) => product.axes.find((axis) => axis.id === "srgbPercent")?.score === null,
    ),
    true,
  );
  assert.equal(
    result.products.every((product) => product.axes.length === 23),
    true,
  );
  const unknown = readConsumerInformation(
    laptop,
    "shop:unknown",
    url,
    "CPUの選択 Core 5/Core 7; CPU基本周波数: 1.4GHz; CPU最大周波数: 5GHz; L3キャッシュ: 12MB; GPU: RTX 4060; 推奨GPU最大周波数: 3000MHz; 最大メモリ速度: 12000MHz; HDMI2.1; HDMIポート数: 2Gbps; sRGBカバー率: 80/100%; ACアダプター: 200W; DDR5-6400MHz",
  );
  for (const id of [
    "cpuBaseGhz",
    "cpuBoostGhz",
    "cpuCacheMb",
    "gpuBoostMhz",
    "gpuPowerW",
    "ramSpeedMtps",
    "hdmiOutputPorts",
    "srgbPercent",
  ]) {
    assert.equal(unknown.specs[id], null, id);
    assert.equal(
      unknown.facts.some((fact) => fact.field === id),
      false,
      id,
    );
  }
  const conflicting = readConsumerInformation(
    laptop,
    "shop:conflict",
    url,
    "CPU基本周波数: 2GHz; CPU基本周波数: 4GHz; CPU最大周波数: 3/5GHz; GPU消費電力: 80/100W",
  );
  for (const id of ["cpuBaseGhz", "cpuBoostGhz", "gpuPowerW"]) {
    assert.equal(conflicting.specs[id], null, id);
  }
});

await test("PC extraction keeps ambiguous variants, advertised limits and mismatched count units unknown", () => {
  const gpuOnly = readConsumerInformation(
    laptop,
    "shop:gpu",
    url,
    "GPU補足 VRAM: 8GB; GPU メモリ: 8GB",
  );
  assert.equal(gpuOnly.specs["gpuVramGb"], 8);
  assert.equal(gpuOnly.specs["ramGb"], null);
  assert.equal(gpuOnly.specs["storageGb"], null);
  assert.equal(
    gpuOnly.facts.every((fact) => fact.field === "gpuVramGb"),
    true,
  );
  assert.equal(gpuOnly.choices.length, 0);
  const variants = readConsumerInformation(
    laptop,
    "shop:variants",
    url,
    "CPU: Core i5/Core i7; GPU: RTX 4050/RTX 4060; CPUコア数: 8/16コア; CPUスレッド数: 16、32スレッド; GPUメモリ: 4GB 8GB; USB-A端子数: 2、4個; USB-C端子数: 1/2個",
  );
  const ambiguousFields = [
    "cpu",
    "gpu",
    "cpuCores",
    "cpuThreads",
    "gpuVramGb",
    "usbAPorts",
    "usbCPorts",
  ];
  for (const field of ambiguousFields) {
    assert.equal(variants.specs[field], null, field);
    assert.ok(variants.conflicts.includes(field), field);
    assert.equal(
      variants.facts.some((fact) => fact.field === field),
      false,
      field,
    );
  }
  const limits = readConsumerInformation(
    laptop,
    "shop:limits",
    url,
    "推奨 GPU: RTX 4090; 最大CPUコア数: 64コア; 最大CPUスレッド数: 128スレッド; 最大GPUメモリ: 32GB; 共有 GPUメモリ: 16GB; 最大USB-A端子数: 12個; USB-C端子数: 2Gbps; 最大輝度: 1200nit; 最大バッテリー容量: 100Wh; 最大高さ: 20mm; GPUコア数: 4096コア; 増設メモリ: 64GB",
  );
  for (const field of [
    "gpu",
    "cpuCores",
    "cpuThreads",
    "gpuVramGb",
    "usbAPorts",
    "usbCPorts",
    "brightnessNits",
    "batteryWh",
    "heightMm",
    "ramGb",
  ]) {
    assert.equal(limits.specs[field], null, field);
  }
  assert.equal(limits.facts.length, 0);
  assert.equal(limits.choices.length, 0);
  for (const caption of ["最大メモリ: 64GB", "増設メモリ: 64GB", "おすすめメモリ: 32GB"]) {
    const advertised = readConsumerInformation(laptop, "shop:advertised", url, caption);
    assert.equal(advertised.specs["ramGb"], null, caption);
    assert.equal(advertised.facts.length, 0, caption);
    assert.equal(advertised.choices.length, 0, caption);
  }
  const adjacentLabels = readConsumerInformation(
    laptop,
    "shop:labels",
    url,
    "CPU: Core Ultra 7, OS: Windows 11; GPU: RTX 4060, GPUメモリ: 8GB",
  );
  assert.equal(adjacentLabels.specs["cpu"], "Core Ultra 7");
  assert.equal(adjacentLabels.specs["gpu"], "RTX 4060");
  assert.equal(adjacentLabels.specs["gpuVramGb"], 8);
});

await test("actual flat PC captions keep bounded models, explicit ports and physical dimensions with normalized evidence", () => {
  const fixtures = [
    {
      id: "laptop",
      caption:
        "OS Windows 11 Home 64bit (日本語版) ディスプレイ LEDバックライト液晶 (1920x1200ドット) CPU AMD Ryzen&#8482 7 8840HS プロセッサー 3.30GHz グラフィックス AMD Radeon&#8482 780M グラフィックス インターフェース USBポート：Type-C：USB 3.2 Gen1×1(映像出力対応)、Type-A：USB 3.2 Gen1×2、HDMI 有線LAN なし ワイヤレスLAN Wi-Fi 6対応 (IEEE802.11ax/ac/a/b/g/n準拠) 内蔵Bluetooth Bluetooth v5.3 本体寸法 (W×D×H)mm 約 343.4x239.5x16.9mm(最薄部) 本体質量 約 1.59kg バッテリー 固定式 3セル リチウムイオンポリマーバッテリー 50Whr使用時間(JEITA2.0):動画再生時 約7.4時間・アイドル時 約11.9時間",
      normalized:
        "OS Windows 11 Home 64bit (日本語版) ディスプレイ LEDバックライト液晶 (1920x1200ドット) CPU AMD Ryzen 7 8840HS プロセッサー 3.30GHz グラフィックス AMD Radeon 780M グラフィックス インターフェース USBポート:Type-C:USB 3.2 Gen1×1(映像出力対応)、Type-A:USB 3.2 Gen1×2、HDMI 有線LAN なし ワイヤレスLAN Wi-Fi 6対応 (IEEE802.11ax/ac/a/b/g/n準拠) 内蔵Bluetooth Bluetooth v5.3 本体寸法 (W×D×H)mm 約 343.4x239.5x16.9mm(最薄部) 本体質量 約 1.59kg バッテリー 固定式 3セル リチウムイオンポリマーバッテリー 50Whr使用時間(JEITA2.0):動画再生時 約7.4時間・アイドル時 約11.9時間",
      expected: {
        cpu: "AMD Ryzen 7 8840HS",
        gpu: "AMD Radeon 780M グラフィックス",
        os: "Windows 11 Home 64bit (日本語版)",
        usbAPorts: 2,
        usbCPorts: 1,
        wifiVersion: "6",
        bluetoothVersion: "5.3",
        wiredLan: false,
        widthMm: 343.4,
        depthMm: 239.5,
        heightMm: 16.9,
        weightG: 1590,
        batteryWh: 50,
        batteryHours: null,
        widthPx: 1920,
        heightPx: 1200,
        cpuCores: null,
        cpuThreads: null,
        gpuVramGb: null,
      },
    },
    {
      id: "desktop",
      caption:
        "OS Windows 11 Home 64bit (日本語版) 形状 Tower（13.6L) ディスプレイ なし CPU インテル&#174 Core&#8482 i5-14400 プロセッサー チップセット インテル&#174 B760 チップセット グラフィックス CPU 内蔵（インテル&#174 UHD グラフィックス 730） インターフェース USB ポー ト：前面：USB3.2 Gen1×2、USB3.2 Gen1 Type-C×1、背面：USB2.0×4 Bluetooth Bluetooth v5.2 拡張スロット 本体寸法（幅×奥行×高さ） 約 145 x 288 x 340mm 本体質量 約 5.4kg",
      normalized:
        "OS Windows 11 Home 64bit (日本語版) 形状 Tower(13.6L) ディスプレイ なし CPU インテル Core i5-14400 プロセッサー チップセット インテル B760 チップセット グラフィックス CPU 内蔵(インテル UHD グラフィックス 730) インターフェース USB ポー ト:前面:USB3.2 Gen1×2、USB3.2 Gen1 Type-C×1、背面:USB2.0×4 Bluetooth Bluetooth v5.2 拡張スロット 本体寸法(幅×奥行×高さ) 約 145 x 288 x 340mm 本体質量 約 5.4kg",
      expected: {
        cpu: "インテル Core i5-14400",
        gpu: "CPU 内蔵(インテル UHD グラフィックス 730)",
        os: "Windows 11 Home 64bit (日本語版)",
        usbAPorts: null,
        usbCPorts: 1,
        bluetoothVersion: "5.2",
        widthMm: 145,
        depthMm: 288,
        heightMm: 340,
        weightG: 5400,
        widthPx: null,
        heightPx: null,
        cpuCores: null,
        cpuThreads: null,
        gpuVramGb: null,
      },
    },
    {
      id: "laptop",
      caption:
        "オペレーティングシステム Windows 11 Home プロセッサー AMD Ryzen&#8482; AI 5 340 6コア/12スレッド・プロセッサー + Radeon&#8482; グラフィックス NPU AMD Ryzen AI 最大50TOPS カラー セラミックホワイト メモリ16GB SSD512GB 内蔵無線LAN IEEE802.11ax (Wi-Fi 6E)、Bluetooth5.3 グラフィックスタイプ AMD Radeon&#8482; 840M グラフィックス (プロセッサーに内蔵) ビデオメモリ メインメモリと共有 ディスプレイタイプ(液晶表示最大解像度/輝度/色域) 13.3インチ IPSディスプレイ (1920×1200 / 400nit / sRGB100% / 最大1677万色) 外部ディスプレイ 最大3840×2160 インターフェイス SuperSpeed USB Type-A 10Gbps×2、SuperSpeed USB Type-C 10Gbps×2 サイズ(幅x奥行きx高さ) 約297×211×16.5-17.4(最厚部)mm バッテリ駆動時間 最大15時間30分",
      normalized:
        "オペレーティングシステム Windows 11 Home プロセッサー AMD Ryzen AI 5 340 6コア/12スレッド・プロセッサー + Radeon グラフィックス NPU AMD Ryzen AI 最大50TOPS カラー セラミックホワイト メモリ16GB SSD512GB 内蔵無線LAN IEEE802.11ax (Wi-Fi 6E)、Bluetooth5.3 グラフィックスタイプ AMD Radeon 840M グラフィックス (プロセッサーに内蔵) ビデオメモリ メインメモリと共有 ディスプレイタイプ(液晶表示最大解像度/輝度/色域) 13.3インチ IPSディスプレイ (1920×1200 / 400nit / sRGB100% / 最大1677万色) 外部ディスプレイ 最大3840×2160 インターフェイス SuperSpeed USB Type-A 10Gbps×2、SuperSpeed USB Type-C 10Gbps×2 サイズ(幅x奥行きx高さ) 約297×211×16.5-17.4(最厚部)mm バッテリ駆動時間 最大15時間30分",
      expected: {
        cpu: "AMD Ryzen AI 5 340",
        gpu: "AMD Radeon 840M グラフィックス (プロセッサーに内蔵)",
        os: "Windows 11 Home",
        cpuCores: 6,
        cpuThreads: 12,
        gpuVramGb: null,
        ramGb: 16,
        storageGb: 512,
        usbAPorts: 2,
        usbCPorts: 2,
        wifiVersion: "6E",
        bluetoothVersion: "5.3",
        widthMm: 297,
        depthMm: 211,
        heightMm: null,
        widthPx: 1920,
        heightPx: 1200,
        brightnessNits: 400,
        batteryHours: null,
      },
    },
  ];
  for (const fixture of fixtures) {
    const category = consumerCategory(fixture.id);
    assert.ok(category !== null);
    const information = readConsumerInformation(category, "shop:flat", url, fixture.caption);
    for (const [field, value] of Object.entries(fixture.expected)) {
      assert.equal(information.specs[field], value, `${fixture.id}.${field}`);
      if (value !== null) {
        assert.ok(information.facts.some((fact) => fact.field === field && fact.value === value));
      }
    }
    assert.equal(
      information.facts.every((fact) => fixture.normalized.includes(fact.quote)),
      true,
    );
  }
  const desktop = consumerCategory("desktop");
  assert.ok(desktop !== null);
  const dense = readConsumerInformation(
    desktop,
    "shop:dense",
    url,
    "メーカーVETESA型番22Y-i52-win11CPUIntel Core i5-2520MOSWindows11 64 ビットOfficeWPS Office 2RAM8GBROMSSD：256GB光学ドライブ無し画面サイズ22インチ解像度FHD1920x1080",
  );
  assert.equal(dense.specs["cpu"], "Intel Core i5-2520M");
  assert.equal(dense.specs["os"], "Windows11 64 ビット");
  assert.equal(dense.specs["widthPx"], 1920);
  assert.equal(dense.specs["heightPx"], 1080);
});

await test("Dell selectable CPUs stay unknown while star-delimited models and explicit USB counts retain evidence", () => {
  const caption =
    "★CPUの選択 ・インテル Core 5 120U (10 コア, 1.4GHz 最大5.0GHzまで可能) ・インテル Core 7 150U (10 コア, 1.8GHz 最大5.4GHzまで可能) ★グラフィックス：Intel Graphics ★メモリ容量 :16GB ★OS：Windows 11 Home ★Office詳細 ★USBポート数：USB 3.2 Gen 1 Type-A (5 Gbps)ポートx2、USB 3.2 Gen 2 (10 Gbps) Type-Cx1（Power Delivery対応）";
  const information = readConsumerInformation(laptop, "shop:dell", url, caption);
  assert.equal(information.specs["cpu"], null);
  assert.ok(information.conflicts.includes("cpu"));
  assert.equal(
    information.facts.some((fact) => fact.field === "cpu"),
    false,
  );
  assert.equal(information.specs["cpuCores"], null);
  assert.equal(information.specs["cpuThreads"], null);
  assert.equal(information.specs["gpu"], "Intel Graphics");
  assert.equal(information.specs["os"], "Windows 11 Home");
  assert.equal(information.specs["ramGb"], 16);
  assert.equal(information.specs["usbAPorts"], 2);
  assert.equal(information.specs["usbCPorts"], 1);
  assert.equal(
    information.facts.every((fact) => caption.normalize("NFKC").includes(fact.quote)),
    true,
  );
  const shortSelection = readConsumerInformation(
    laptop,
    "shop:dell-selection",
    url,
    "CPU選択 Intel Core 5 120U / Intel Core 7 150U; Type-A (5 Gbps)ポート; Type-C (10 Gbps)",
  );
  assert.equal(shortSelection.specs["cpu"], null);
  assert.ok(shortSelection.conflicts.includes("cpu"));
  assert.equal(shortSelection.specs["usbAPorts"], null);
  assert.equal(shortSelection.specs["usbCPorts"], null);
});

await test("flat PC extraction keeps versions, advertised limits, conflicting models and invalid entities safe", () => {
  const unknown = readConsumerInformation(
    laptop,
    "shop:flat-limits",
    url,
    "推奨 CPU AMD Ryzen 9 9950X プロセッサー; 推奨 GPU NVIDIA RTX 5090; Type-A USB3.2 Gen1; Type-C10Gbps; 最大Type-A10Gbps×6; 最大本体寸法(W×D×H) 500x400x100mm; バッテリー 最大100Whr; プロセッサー 3.30GHz; CPU: Core i5/Core i7; GPU: RTX 4050/RTX 4060",
  );
  for (const field of [
    "cpu",
    "gpu",
    "usbAPorts",
    "usbCPorts",
    "widthMm",
    "heightMm",
    "depthMm",
    "batteryWh",
  ]) {
    assert.equal(unknown.specs[field], null, field);
  }
  assert.ok(unknown.conflicts.includes("cpu"));
  assert.ok(unknown.conflicts.includes("gpu"));
  assert.equal(unknown.facts.length, 0);
  for (const entity of ["&#x110000;", "&#55296;", "&#0;", "&#999999999999999999999;"]) {
    const information = readConsumerInformation(
      laptop,
      "shop:invalid-entity",
      url,
      `メモリ16GB ${entity}`,
    );
    assert.equal(information.specs["ramGb"], 16, entity);
    assert.ok(
      information.facts.some((fact) => fact.quote.includes(entity.slice(0, -1))),
      entity,
    );
  }
});

await test("zero-valued PC counts score as evidence, tie at zero and remain distinct from missing values", () => {
  const listing = (id: string, ports: number | null): TestListing => ({
    listingId: id,
    identityVerified: false,
    availability: "available",
    tax: "included",
    price: { minimum: 10000, maximum: 10000 },
    condition: "new",
    consumerInformation: readConsumerInformation(
      laptop,
      id,
      url,
      ports === null ? "メモリ: 16GB" : `メモリ: 16GB; USB-A端子数: ${ports}個`,
    ),
  });
  const comparison = compareConsumerListings(
    [listing("zero", 0), listing("positive", 2), listing("missing", null)],
    laptop,
    {},
    "recommendation",
  );
  assert.deepEqual(
    comparison.products.map((product) => [
      product.consumerInformation.specs["usbAPorts"],
      product.axes.find((axis) => axis.id === "usbAPorts")?.score,
    ]),
    [
      [0, 0],
      [2, 100],
      [null, null],
    ],
  );
  const tied = compareConsumerListings(
    [listing("zero-first", 0), listing("zero-second", 0)],
    laptop,
    {},
    "recommendation",
  );
  assert.equal(tied.status, "ranked");
  assert.deepEqual(
    tied.products.map((product) => [
      product.axes.find((axis) => axis.id === "usbAPorts")?.score,
      product.recommendationPercent,
      product.rank,
    ]),
    [
      [100, 100, 1],
      [100, 100, 1],
    ],
  );
});

await test("Jev can only choose a supplied quote and cannot overwrite deterministic facts", () => {
  const information = readConsumerInformation(
    laptop,
    "shop:product",
    url,
    "作業領域は16GB、保存領域は512GBです。",
  );
  const ram = information.choices.find((choice) => choice.field === "ramGb");
  assert.ok(ram !== undefined);
  const selected = ram.options.find((option) => option.fact.value === 16);
  assert.ok(selected !== undefined);
  assert.equal(applyConsumerChoices(information, { [ram.id]: "invented" }).specs["ramGb"], null);
  assert.equal(applyConsumerChoices(information, { [ram.id]: "conflict" }).specs["ramGb"], null);
  const result = applyConsumerChoices(information, { [ram.id]: selected.id });
  assert.equal(result.specs["ramGb"], 16);
  assert.equal(result.facts[0]?.method, "jev_choice");
  const known = readConsumerInformation(
    laptop,
    "shop:known",
    url,
    "メモリ: 8GB\n保存領域は512GBです。",
  );
  assert.equal(applyConsumerChoices(known, { "shop:known_ramGb": "option_0" }).specs["ramGb"], 8);
  assert.equal(readConsumerInformation(laptop, "shop:ram", url, "メモリ: 16GB").choices.length, 0);
  const partial = readConsumerInformation(
    laptop,
    "shop:partial",
    url,
    "RAM: 16GB、保存領域は512GBです。",
  );
  assert.deepEqual(
    partial.choices
      .find((choice) => choice.field === "storageGb")
      ?.options.map((option) => option.fact.value),
    [512],
  );
});

await test("numeric filtering and ties preserve source, cheap matches and unknowns without invented scores", () => {
  const listing = (id: string, price: number, input: string): TestListing => ({
    listingId: id,
    identityVerified: true,
    availability: "available",
    tax: "included",
    price: { minimum: price, maximum: price },
    consumerInformation: readConsumerInformation(laptop, id, url, input),
    condition: "new",
  });
  const source = listing("source", 100000, "メモリ: 8GB\n重量: 1.2kg");
  const cheap = listing("cheap", 30000, "メモリ: 16GB\n重量: 1.1kg");
  const tie = listing("tie", 30000, "メモリ: 32GB\n重量: 1.4kg");
  const ranked = compareConsumerListings(
    [source, cheap, tie],
    laptop,
    { ramGb: 16, weightG: 1500 },
    "price",
  );
  assert.equal(ranked.status, "ranked");
  assert.deepEqual(
    ranked.products.map((product) => [product.listingId, product.status, product.rank]),
    [
      ["source", "excluded", null],
      ["cheap", "eligible", 1],
      ["tie", "eligible", 1],
    ],
  );
  const pending = listing("unknown", 10000, "重量: 1.1kg");
  const result = compareConsumerListings([source, cheap, pending], laptop, { ramGb: 16 }, "price");
  assert.equal(result.status, "needs_information");
  assert.equal(
    result.products.every((product) => product.rank === null),
    true,
  );
  assert.equal(
    compareConsumerListings(
      [{ ...cheap, price: { minimum: 30000, maximum: 40000 } }],
      laptop,
      {},
      "price",
    ).status,
    "compared",
  );
  assert.equal(
    compareConsumerListings([cheap], laptop, {}, "specifications").products[0]?.rank,
    null,
  );
  assert.equal(
    assessConsumerListing({ ...cheap, identityVerified: false }, laptop, {}).status,
    "eligible",
  );
});

await test("consumer recommendation indices use verified numeric axes, preserve cheaper choices, ties and missing facts", () => {
  for (const category of consumerCategories) {
    const caption =
      "メモリ: 16GB\nSSD: 512GB\n重量: 1.2kg\n画面サイズ: 27インチ\n解像度: 3840×2160\nリフレッシュレート: 60Hz";
    const listing = (id: string, price: number, input = caption): TestListing => ({
      listingId: id,
      identityVerified: true,
      availability: "available",
      tax: "included",
      price: { minimum: price, maximum: price },
      consumerInformation: readConsumerInformation(category, id, url, input),
      condition: "new",
    });
    const source = listing("source", 80000);
    const cheap = listing("cheap", 40000);
    const tied = listing("tied", 40000);
    const result = compareConsumerListings([source, cheap, tied], category, {}, "recommendation");
    assert.equal(result.status, "ranked", category.id);
    assert.deepEqual(
      result.products.map((product) => [
        product.listingId,
        product.rank,
        product.recommendationPercent,
      ]),
      [
        ["cheap", 1, 100],
        ["tied", 1, 100],
        ["source", 3, category.id === "laptop" || category.id === "desktop" ? 92 : 88],
      ],
    );
    assert.equal(
      result.products[0]?.axes.some((axis) => axis.id === "cpu"),
      false,
    );
    const withoutCatalogIdentity = compareConsumerListings(
      [
        { ...source, identityVerified: false },
        { ...cheap, identityVerified: false },
      ],
      category,
      {},
      "recommendation",
    );
    assert.equal(withoutCatalogIdentity.status, "ranked", category.id);
    assert.deepEqual(
      withoutCatalogIdentity.products.map((product) => [
        product.listingId,
        product.rank,
        product.recommendationPercent,
      ]),
      [
        ["cheap", 1, 100],
        ["source", 2, category.id === "laptop" || category.id === "desktop" ? 92 : 88],
      ],
    );
    const ranged = compareConsumerListings(
      [source, { ...cheap, price: { minimum: 40000, maximum: 50000 } }],
      category,
      {},
      "recommendation",
    );
    assert.equal(ranged.status, "ranked", category.id);
    assert.equal(
      ranged.products.every(
        (product) =>
          product.recommendationPercent === 100 &&
          product.rank === 1 &&
          product.axes.find((axis) => axis.id === "price")?.score === null,
      ),
      true,
    );
    const missing = compareConsumerListings(
      [source, listing("missing", 40000, "CPU: Core i9")],
      category,
      {},
      "recommendation",
    );
    assert.equal(missing.status, "needs_information", category.id);
    assert.equal(
      missing.products.every(
        (product) => product.recommendationPercent === null && product.rank === null,
      ),
      true,
    );
    assert.deepEqual(
      missing.products.map((product) => product.axes.find((axis) => axis.id === "price")?.score),
      [50, 100],
    );
    assert.equal(
      missing.products.every((product) =>
        product.axes.filter((axis) => axis.id !== "price").every((axis) => axis.score === null),
      ),
      true,
    );
    assert.equal(
      compareConsumerListings([source], category, {}, "recommendation").products[0]
        ?.recommendationPercent,
      null,
    );
  }
});

await test("partial listing evidence ranks shared totals while pending conditions and price-only evidence hold ranks", () => {
  const unknownAxes = laptop.axes.slice(4).map(() => null);
  const listing = (id: string, price: number, caption: string): TestListing => ({
    listingId: id,
    identityVerified: false,
    availability: "available",
    tax: "included",
    price: { minimum: price, maximum: price },
    condition: "new",
    consumerInformation: readConsumerInformation(laptop, id, url, caption),
  });
  const source = listing("source", 100000, "メモリ16GB\nSSD512GB\n重量1.2kg");
  const moreMemory = listing("memory", 50000, "メモリ32GB\nSSD256GB");
  const moreStorage = listing("storage", 25000, "SSD1024GB\n重量1kg");
  const result = compareConsumerListings(
    [source, moreMemory, moreStorage],
    laptop,
    {},
    "recommendation",
  );
  assert.equal(result.status, "ranked");
  assert.deepEqual(
    result.products.map((product) => [
      product.listingId,
      product.axes.map((axis) => axis.score),
      product.recommendationPercent,
      product.rank,
    ]),
    [
      ["storage", [100, null, 100, 100, ...unknownAxes], 100, 1],
      ["source", [25, 50, 50, 83, ...unknownAxes], 38, 2],
      ["memory", [50, 100, 25, null, ...unknownAxes], 38, 2],
    ],
  );
  const pending = compareConsumerListings(
    [source, moreMemory, moreStorage],
    laptop,
    { ramGb: 8 },
    "recommendation",
  );
  assert.equal(pending.status, "needs_information");
  assert.deepEqual(
    pending.products.map((product) => [
      product.status,
      product.axes.map((axis) => axis.score),
      product.recommendationPercent,
      product.rank,
    ]),
    [
      ["eligible", [50, 50, 100, null, ...unknownAxes], 67, null],
      ["eligible", [100, 100, 50, null, ...unknownAxes], 83, null],
      ["pending", [null, null, null, null, ...unknownAxes], null, null],
    ],
  );
  const priceOnly = compareConsumerListings(
    [listing("source-price", 100000, ""), listing("candidate-price", 50000, "")],
    laptop,
    {},
    "recommendation",
  );
  assert.equal(priceOnly.status, "needs_information");
  assert.deepEqual(
    priceOnly.products.map((product) => [
      product.axes.map((axis) => axis.score),
      product.recommendationPercent,
      product.rank,
    ]),
    [
      [[50, null, null, null, ...unknownAxes], null, null],
      [[100, null, null, null, ...unknownAxes], null, null],
    ],
  );
});
