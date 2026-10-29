import { resolveApiBase } from "./consumer-http.js";
import { parseInvestigation } from "./index.js";
import type { Investigation } from "./index.js";

export type MonitorConditions = Readonly<{
  screenSize: 24 | 27 | 32 | null;
  minResolution: "qhd" | "4k" | null;
  usbCPowerW: 0 | 65 | 90;
  heightAdjustable: boolean;
}>;
export type MonitorSpecifications = Readonly<{
  screenSizeInches: number | null;
  resolutionWidthPx: number | null;
  resolutionHeightPx: number | null;
  refreshRateHz: number | null;
  usbCPowerW: number | null;
  usbCVideo: boolean | null;
  hdmiPorts: number | null;
  displayPortPorts: number | null;
  heightAdjustable: boolean | null;
  warrantyMonths: number | null;
}>;
type LiveProduct = Extract<Investigation, { mode: "live" }>;
type MonitorProduct = LiveProduct &
  Readonly<{
    monitorSpecifications: MonitorSpecifications;
    status: "eligible" | "excluded" | "pending";
    rank: number | null;
    reasons: readonly string[];
  }>;
export type MonitorComparison = Readonly<{
  category: "work-monitor";
  sort: "price" | "specifications";
  conditions: MonitorConditions;
  source: LiveProduct;
  keyword: "モニター";
  aiCalls: 0;
  status: "compared" | "ranked" | "needs_information" | "no_match";
  products: readonly MonitorProduct[];
}>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function conditions(input: unknown): MonitorConditions {
  if (
    !record(input) ||
    Object.keys(input).length !== 4 ||
    (input["screenSize"] !== null &&
      input["screenSize"] !== 24 &&
      input["screenSize"] !== 27 &&
      input["screenSize"] !== 32) ||
    (input["minResolution"] !== null &&
      input["minResolution"] !== "qhd" &&
      input["minResolution"] !== "4k") ||
    (input["usbCPowerW"] !== 0 && input["usbCPowerW"] !== 65 && input["usbCPowerW"] !== 90) ||
    typeof input["heightAdjustable"] !== "boolean"
  ) {
    throw new Error("モニターの比較条件を確認してください");
  }
  return Object.freeze({
    screenSize: input["screenSize"],
    minResolution: input["minResolution"],
    usbCPowerW: input["usbCPowerW"],
    heightAdjustable: input["heightAdjustable"],
  });
}

function specifications(input: unknown): MonitorSpecifications {
  if (!record(input)) {
    throw new Error("モニター仕様を検証できませんでした");
  }
  const number = (key: string, min: number, max: number, integer = false): number | null => {
    const value = input[key];
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value)))
    ) {
      throw new Error("モニター仕様を検証できませんでした");
    }
    return value;
  };
  const boolean = (key: string): boolean | null => {
    const value = input[key];
    if (value !== null && typeof value !== "boolean") {
      throw new Error("モニター仕様を検証できませんでした");
    }
    return value;
  };
  const width = number("resolutionWidthPx", 640, 7680, true);
  const height = number("resolutionHeightPx", 480, 4320, true);
  if ((width === null) !== (height === null)) {
    throw new Error("解像度を検証できませんでした");
  }
  return Object.freeze({
    screenSizeInches: number("screenSizeInches", 10, 100),
    resolutionWidthPx: width,
    resolutionHeightPx: height,
    refreshRateHz: number("refreshRateHz", 30, 500),
    usbCPowerW: number("usbCPowerW", 0, 240),
    usbCVideo: boolean("usbCVideo"),
    hdmiPorts: number("hdmiPorts", 0, 8, true),
    displayPortPorts: number("displayPortPorts", 0, 8, true),
    heightAdjustable: boolean("heightAdjustable"),
    warrantyMonths: number("warrantyMonths", 1, 120, true),
  });
}

function parseComparison(input: unknown): MonitorComparison {
  if (record(input) && input["tag"] === "err") {
    parseInvestigation(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (
    !record(value) ||
    value["category"] !== "work-monitor" ||
    (value["sort"] !== "price" && value["sort"] !== "specifications") ||
    value["keyword"] !== "モニター" ||
    value["aiCalls"] !== 0 ||
    (value["status"] !== "compared" &&
      value["status"] !== "ranked" &&
      value["status"] !== "needs_information" &&
      value["status"] !== "no_match") ||
    !Array.isArray(value["products"]) ||
    value["products"].length > 6
  ) {
    throw new Error("モニター比較を検証できませんでした");
  }
  const checked = conditions(value["conditions"]);
  if (!record(value["source"]) || value["source"]["genreId"] !== "110105") {
    throw new Error("入力商品のカテゴリを検証できませんでした");
  }
  const source = parseInvestigation({ tag: "ok", value: value["source"] });
  if (source.mode !== "live") {
    throw new Error("入力商品を検証できませんでした");
  }
  const raw: readonly unknown[] = value["products"];
  const products = raw.map((entry): MonitorProduct => {
    if (
      !record(entry) ||
      entry["genreId"] !== "110105" ||
      (entry["status"] !== "eligible" &&
        entry["status"] !== "excluded" &&
        entry["status"] !== "pending") ||
      !Array.isArray(entry["reasons"]) ||
      !entry["reasons"].every((reason: unknown) => typeof reason === "string")
    ) {
      throw new Error("比較対象を検証できませんでした");
    }
    const listing = parseInvestigation({ tag: "ok", value: entry });
    if (listing.mode !== "live") {
      throw new Error("比較対象を検証できませんでした");
    }
    const specs = specifications(entry["monitorSpecifications"]);
    if (
      entry["status"] === "eligible" &&
      (!listing.identityVerified ||
        listing.availability !== "available" ||
        specs.screenSizeInches === null ||
        specs.screenSizeInches < 23 ||
        specs.screenSizeInches > 32 ||
        (checked.screenSize !== null &&
          Math.abs(specs.screenSizeInches - checked.screenSize) > 1) ||
        (checked.minResolution !== null &&
          ((specs.resolutionWidthPx ?? 0) < (checked.minResolution === "4k" ? 3840 : 2560) ||
            (specs.resolutionHeightPx ?? 0) < (checked.minResolution === "4k" ? 2160 : 1440))) ||
        (checked.usbCPowerW > 0 &&
          (specs.usbCVideo !== true || (specs.usbCPowerW ?? -1) < checked.usbCPowerW)) ||
        (checked.heightAdjustable && specs.heightAdjustable !== true))
    ) {
      throw new Error("条件への適合を検証できませんでした");
    }
    const rank = entry["rank"];
    if (
      (rank !== null &&
        (typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1 || rank > 6)) ||
      (rank !== null && (value["status"] !== "ranked" || entry["status"] !== "eligible"))
    ) {
      throw new Error("価格順位を検証できませんでした");
    }
    const reasons: readonly unknown[] = entry["reasons"];
    return Object.freeze({
      ...listing,
      monitorSpecifications: specs,
      status: entry["status"],
      rank,
      reasons: Object.freeze(
        reasons.flatMap((reason) => (typeof reason === "string" ? [reason] : [])),
      ),
    });
  });
  const eligible = products.filter((product) => product.status === "eligible");
  const sourceProduct = products.find(
    (product) =>
      product.listingId === source.listingId && product.canonicalUrl === source.canonicalUrl,
  );
  if (
    sourceProduct === undefined ||
    JSON.stringify(parseInvestigation({ tag: "ok", value: sourceProduct })) !==
      JSON.stringify(source)
  ) {
    throw new Error("入力商品の情報が一致しません");
  }
  const identities = products.map((product) =>
    product.identityVerified ? product.specifications.gtin : product.listingId,
  );
  if (
    products.filter(
      (product) =>
        product.listingId === source.listingId && product.canonicalUrl === source.canonicalUrl,
    ).length !== 1 ||
    new Set(products.map((product) => product.listingId)).size !== products.length ||
    new Set(products.map((product) => product.canonicalUrl)).size !== products.length ||
    new Set(identities).size !== products.length ||
    (products.some((product) => product.status === "pending") &&
      value["status"] !== "needs_information") ||
    (value["status"] === "no_match" &&
      (eligible.length > 0 || products.some((product) => product.status === "pending"))) ||
    (value["status"] === "ranked" &&
      (value["sort"] !== "price" ||
        eligible.length === 0 ||
        products.some((product) => product.status === "pending") ||
        eligible.some(
          (product) =>
            product.tax !== "included" ||
            product.price.minimum <= 0 ||
            product.price.minimum !== product.price.maximum ||
            product.rank !==
              1 + eligible.filter((other) => other.price.minimum < product.price.minimum).length,
        )))
  ) {
    throw new Error("比較順位や商品同定が一致しません");
  }
  return Object.freeze({
    category: "work-monitor",
    sort: value["sort"],
    conditions: checked,
    source,
    keyword: "モニター",
    aiCalls: 0,
    status: value["status"],
    products: Object.freeze(products),
  });
}

export async function compareMonitors(
  url: string,
  input: MonitorConditions,
  sort: "price" | "specifications",
  options: Readonly<{ keyword?: string; accessToken?: string }> = {},
): Promise<MonitorComparison> {
  const checked = conditions(input);
  if (!URL.canParse(url)) {
    throw new Error("商品URLを確認してください");
  }
  const requested = new URL(url);
  if (
    requested.protocol !== "https:" ||
    requested.hostname !== "item.rakuten.co.jp" ||
    requested.username !== "" ||
    requested.password !== "" ||
    requested.port !== ""
  ) {
    throw new Error("楽天の商品URLを入力してください");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.accessToken !== undefined && options.accessToken.length > 0) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.accessToken)) {
      throw new Error("動作確認用トークンの形式を確認してください");
    }
    headers["authorization"] = `Bearer ${options.accessToken}`;
  }
  const response = await fetch(`${resolveApiBase()}/api/monitors`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url,
      conditions: checked,
      sort,
      keyword: (options.keyword?.trim() ?? "").length === 0 ? null : options.keyword?.trim(),
    }),
    signal: AbortSignal.timeout(95_000),
  });
  if (response.headers.get("content-type")?.includes("application/json") !== true) {
    throw new Error("商品APIが未接続です。APIの接続設定を確認してください");
  }
  const body: unknown = await response.json();
  const result = parseComparison(body);
  if (
    result.source.canonicalUrl !==
      `${requested.origin}${requested.pathname.replace(/\/?$/, "/")}` ||
    result.sort !== sort ||
    JSON.stringify(result.conditions) !== JSON.stringify(checked)
  ) {
    throw new Error("比較対象や条件が変わりました。再取得してください");
  }
  return result;
}
