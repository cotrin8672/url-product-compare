import { resolveApiBase } from "./consumer-http.js";
export { fetchSecuritiesComparison, parseSecuritiesComparison } from "./securities.js";
export type { SecuritiesRequest, SecuritiesComparison } from "./securities.js";
export { prepareSecuritiesSubmission, securitiesDraftMatches } from "./securities-form.js";
export type {
  SecuritiesDraft,
  SecuritiesFormIssue,
  SecuritiesSubmission,
} from "./securities-form.js";

export { compareMonitors } from "./monitors.js";
export {
  fetchCommerceSources,
  fetchCommerceListings,
  fetchCommerceAffiliateLink,
  parseCommercePage,
  fetchFurusatoComparison,
} from "./commerce.js";
export type { FurusatoField, FurusatoComparison, FurusatoComparisonRequest } from "./furusato.js";
export type {
  CommerceSource,
  CommerceRequest,
  CommerceListing,
  CommercePage,
  CommerceSourceStatus,
} from "./commerce.js";
export {
  cancelConsumerComparisonJob,
  compareConsumerProducts,
  consumerCategories,
  createComparisonOperation,
  detectProductCategory,
  fetchProductCatalog,
  isAutomaticCategory,
  pollConsumerComparisonJob,
  readConsumerComparisonJob,
  resetConsumerCatalogCache,
  startConsumerComparisonJob,
} from "./consumer.js";
export type {
  ComparisonJob,
  ComparisonOperation,
  ConsumerComparison,
  ConsumerSort,
  DetectResult,
  ProductCatalog,
  StoredComparisonSession,
} from "./consumer.js";
export {
  clearComparisonSession,
  comparisonJobCannotResume,
  comparisonErrorMessage,
  comparisonRecoveryAction,
  productCatalogFailure,
  normalizeProductUrl,
  parseConsumerComparison,
  parseDetectResult,
  parseProductCatalog,
  parsePublicCompareRoute,
  readActiveComparisonCategory,
  readComparisonSession,
  writeComparisonSession,
} from "./consumer.js";
export {
  comparisonDetailLayout,
  comparisonStageLabel,
  comparisonAxisWeightPercent,
  comparisonDisplayExpiresAt,
  comparisonDisplayRemainingMs,
  createComparisonRequestScope,
  phaseFromJobState,
  shouldPollJob,
  waitForComparisonPoll,
} from "./consumer-ui.js";
export type { ComparisonRequest } from "./consumer-ui.js";
export type { MonitorComparison, MonitorConditions, MonitorSpecifications } from "./monitors.js";

type ProductSpecifications = Readonly<{
  model: string | null;
  brand: string | null;
  gtin: string | null;
  color: string | null;
  maxPowerW: number | null;
  usbCPorts: number | null;
  usbAPorts: number | null;
  weightG: number | null;
  warrantyMonths: number | null;
}>;

type InvestigationFields = Readonly<{
  notice: string;
  provider: string;
  listingId: string;
  title: string;
  canonicalUrl: string;
  observedAt: string;
}>;

export type Investigation = InvestigationFields &
  (
    | Readonly<{ mode: "demo"; productId: string; matchMethod: string }>
    | Readonly<{
        mode: "official";
        provider: "elecom";
        productId: string;
        matchMethod: "manufacturer_model_gtin_variant";
        expiresAt: string;
        gtin: string;
        color: string;
        weightG: number;
        dimensionsMm: readonly number[];
        maxPowerW: number;
        portCount: number;
      }>
    | Readonly<{
        mode: "live";
        productId: null;
        matchMethod: null;
        expiresAt: string;
        affiliateUrl: string;
        shopName: string;
        price: Readonly<{ minimum: number; maximum: number; currency: "JPY" }>;
        tax: "included" | "excluded";
        shipping: "included" | "excluded";
        availability: "available" | "unavailable";
        imageUrl: string | null;
        identityVerified: boolean;
        rakutenProductId: string | null;
        specifications: ProductSpecifications;
      }>
  );

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function productSpecifications(input: unknown): ProductSpecifications {
  if (input !== undefined && !record(input)) {
    throw new Error("商品仕様を検証できませんでした");
  }
  const data = record(input) ? input : {};
  const text = (key: string): string | null => {
    const value = data[key] ?? null;
    if (
      value !== null &&
      (typeof value !== "string" || value.trim().length === 0 || value.length > 256)
    ) {
      throw new Error("商品仕様を検証できませんでした");
    }
    return value;
  };
  const number = (key: string, maximum: number, integer = false): number | null => {
    const value = data[key] ?? null;
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > maximum ||
        (integer && !Number.isInteger(value)))
    ) {
      throw new Error("商品仕様を検証できませんでした");
    }
    return value;
  };
  const gtin = text("gtin");
  if (gtin !== null && !/^(?:\d{8}|\d{12,14})$/.test(gtin)) {
    throw new Error("製品コードを検証できませんでした");
  }
  return Object.freeze({
    model: text("model"),
    brand: text("brand"),
    gtin,
    color: text("color"),
    maxPowerW: number("maxPowerW", 2000),
    usbCPorts: number("usbCPorts", 32, true),
    usbAPorts: number("usbAPorts", 32, true),
    weightG: number("weightG", 100_000),
    warrantyMonths: number("warrantyMonths", 120, true),
  });
}

function listingAffiliateUrl(input: unknown, canonicalUrl: string): input is string {
  if (typeof input !== "string" || input.length > 8192 || !URL.canParse(input)) {
    return false;
  }
  const url = new URL(input);
  const pc = url.searchParams.getAll("pc");
  const mobile = url.searchParams.getAll("m");
  const [destination] = pc;
  if (
    url.origin !== "https://hb.afl.rakuten.co.jp" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^\/hgc\/[a-fA-F0-9]{8}(?:\.[a-fA-F0-9]{8}){3}\/$/.test(url.pathname) ||
    url.hash !== "" ||
    pc.length !== 1 ||
    mobile.length > 1 ||
    destination === undefined ||
    !URL.canParse(destination) ||
    [...url.searchParams.keys()].some((key) => !["pc", "m", "scid", "link_type"].includes(key)) ||
    mobile.some((entry) => entry !== destination)
  ) {
    return false;
  }
  const item = new URL(destination);
  return (
    item.origin === "https://item.rakuten.co.jp" &&
    item.username === "" &&
    item.password === "" &&
    item.hash === "" &&
    /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/.test(item.pathname) &&
    `${item.origin}${item.pathname.replace(/\/?$/, "/")}` === canonicalUrl &&
    [...item.searchParams.keys()].every((key) =>
      [
        "scid",
        "rafcid",
        "s-id",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
      ].includes(key),
    )
  );
}

export function parseInvestigation(input: unknown): Investigation {
  if (!record(input)) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  if (input["tag"] === "err") {
    const error = input["error"];
    const code = record(error) ? error["code"] : null;
    const messages: Readonly<Record<string, string>> = {
      unauthorized: "接続設定に動作確認用トークンを入力してください",
      main_ai_not_configured: "メインAIが未設定です。サーバーのOPENAI_API_KEYを設定してください",
      main_ai_unauthorized: "OpenAIのAPIキーとモデルの利用権限を確認してください",
      main_ai_rate_limited: "OpenAIの利用制限に達しました。時間をおいて再試行してください",
      main_ai_unavailable: "メインAIに接続できませんでした。時間をおいて再試行してください",
      invalid_ai_response:
        "メインAIの検索条件を検証できませんでした。条件を変えて再試行してください",
      provider_unauthorized: "楽天のアプリID・アクセスキー・許可ドメインを確認してください",
      provider_rate_limited: "楽天APIの利用制限に達しました。時間をおいて再試行してください",
      provider_unavailable: "楽天APIに接続できませんでした。時間をおいて再試行してください",
      listing_not_found: "掲載を取得できませんでした。接続設定に商品名を入力して再試行してください",
      lookup_incomplete:
        "検索結果が多いため掲載を確認できません。接続設定の商品名を絞って再試行してください",
      ambiguous_listing: "掲載URLに一致する結果が複数あり、確定できませんでした",
      source_not_authorized:
        "商品データの取得・表示許諾が期限切れです。サーバー設定を確認してください",
      unsupported_url:
        "この商品URLは現在の比較フローでは未対応です。楽天市場の商品URLまたは対応メーカーの公式URLを入力してください",
      unsupported_monitor_category:
        "仕事用モニターの楽天商品URLを入力してください。ほかのカテゴリは現在の対象外です。",
      invalid_url: "商品URLを確認してください",
      invalid_request: "商品URLと補助の商品名（UTF-8で128バイト以内）を確認してください",
      invalid_keyword: "接続設定に商品名を入力してください（UTF-8で128バイト以内）",
      invalid_data: "楽天APIの応答を検証できませんでした",
      storage_unavailable: "実行記録を保存できませんでした。時間をおいて再試行してください",
      method_not_allowed: "APIの呼び出し方法が対応していません",
      demo_not_enabled: "この接続では架空商品の比較は利用できません",
      unsupported_official_url:
        "対応するメーカー公式URLを入力してください（MPA-ACCP4245WH / MPA-ACCP4365BK / MPA-AC113100BK / MPA-AC12465BK）",
      official_source_unavailable:
        "メーカー公式仕様を取得できませんでした。時間をおいて再試行してください",
      official_specification_changed:
        "公式仕様または型番情報が変更されました。仕様の再確認が必要なため判定を止めました",
    };
    throw new Error(
      typeof code === "string"
        ? (messages[code] ?? "商品を確認できませんでした")
        : "APIの応答を読み取れませんでした",
    );
  }
  const value = input["value"];
  if (
    input["tag"] !== "ok" ||
    !record(value) ||
    (value["mode"] !== "demo" && value["mode"] !== "live" && value["mode"] !== "official") ||
    typeof value["notice"] !== "string" ||
    typeof value["provider"] !== "string" ||
    typeof value["listingId"] !== "string" ||
    typeof value["title"] !== "string" ||
    typeof value["canonicalUrl"] !== "string" ||
    typeof value["observedAt"] !== "string" ||
    !URL.canParse(value["canonicalUrl"]) ||
    new URL(value["canonicalUrl"]).protocol !== "https:" ||
    !Number.isFinite(Date.parse(value["observedAt"])) ||
    new Date(value["observedAt"]).toISOString() !== value["observedAt"]
  ) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  const common = {
    notice: value["notice"],
    provider: value["provider"],
    listingId: value["listingId"],
    title: value["title"],
    canonicalUrl: value["canonicalUrl"],
    observedAt: value["observedAt"],
  } satisfies InvestigationFields;
  if (value["mode"] === "official") {
    const dimensions = value["dimensionsMm"];
    const gtin = value["gtin"];
    if (
      value["provider"] !== "elecom" ||
      typeof value["productId"] !== "string" ||
      !/^[A-Z0-9-]+$/.test(value["productId"]) ||
      value["listingId"] !== value["productId"] ||
      common.canonicalUrl !== `https://www.elecom.co.jp/products/${value["productId"]}.html` ||
      value["matchMethod"] !== "manufacturer_model_gtin_variant" ||
      !validInstant(value["expiresAt"]) ||
      value["expiresAt"] <= common.observedAt ||
      typeof gtin !== "string" ||
      !/^\d{13}$/.test(gtin) ||
      Array.from(gtin, Number)
        .toReversed()
        .reduce((sum, digit, index) => sum + digit * (index % 2 === 0 ? 1 : 3), 0) %
        10 !==
        0 ||
      typeof value["color"] !== "string" ||
      value["color"].trim().length === 0 ||
      typeof value["weightG"] !== "number" ||
      !Number.isFinite(value["weightG"]) ||
      value["weightG"] <= 0 ||
      typeof value["maxPowerW"] !== "number" ||
      !Number.isFinite(value["maxPowerW"]) ||
      value["maxPowerW"] <= 0 ||
      value["maxPowerW"] > 240 ||
      typeof value["portCount"] !== "number" ||
      !Number.isInteger(value["portCount"]) ||
      value["portCount"] < 1 ||
      value["portCount"] > 4 ||
      !Array.isArray(dimensions) ||
      dimensions.length !== 3 ||
      !dimensions.every(
        (dimension: unknown) =>
          typeof dimension === "number" && Number.isFinite(dimension) && dimension > 0,
      )
    ) {
      throw new Error("公式製品の同定情報を検証できませんでした");
    }
    const checked: readonly unknown[] = dimensions;
    return Object.freeze({
      ...common,
      mode: "official",
      provider: "elecom",
      productId: value["productId"],
      matchMethod: "manufacturer_model_gtin_variant",
      expiresAt: value["expiresAt"],
      gtin,
      color: value["color"],
      weightG: value["weightG"],
      dimensionsMm: Object.freeze(
        checked.flatMap((dimension) => (typeof dimension === "number" ? [dimension] : [])),
      ),
      maxPowerW: value["maxPowerW"],
      portCount: value["portCount"],
    });
  }
  if (
    value["mode"] === "demo" &&
    typeof value["productId"] === "string" &&
    typeof value["matchMethod"] === "string"
  ) {
    return Object.freeze({
      ...common,
      mode: "demo",
      productId: value["productId"],
      matchMethod: value["matchMethod"],
    });
  }
  const price = value["price"];
  const tax = value["tax"];
  const shipping = value["shipping"];
  const availability = value["availability"];
  const expiresAt = value["expiresAt"];
  const affiliateUrl = value["affiliateUrl"];
  const imageUrl = value["imageUrl"] ?? null;
  const identityVerified = value["identityVerified"] ?? false;
  const rakutenProductId = value["rakutenProductId"] ?? null;
  const specifications = productSpecifications(value["specifications"]);
  if (
    value["mode"] !== "live" ||
    value["productId"] !== null ||
    value["matchMethod"] !== null ||
    value["provider"] !== "rakuten" ||
    new URL(common.canonicalUrl).hostname !== "item.rakuten.co.jp" ||
    !listingAffiliateUrl(affiliateUrl, common.canonicalUrl) ||
    typeof value["shopName"] !== "string" ||
    value["shopName"].trim().length === 0 ||
    !record(price) ||
    price["currency"] !== "JPY" ||
    typeof price["minimum"] !== "number" ||
    !Number.isSafeInteger(price["minimum"]) ||
    price["minimum"] < 0 ||
    typeof price["maximum"] !== "number" ||
    !Number.isSafeInteger(price["maximum"]) ||
    price["maximum"] < price["minimum"] ||
    (tax !== "included" && tax !== "excluded") ||
    (shipping !== "included" && shipping !== "excluded") ||
    (availability !== "available" && availability !== "unavailable") ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt ||
    expiresAt <= common.observedAt ||
    (imageUrl !== null &&
      (!publicHttps(imageUrl) || !new URL(imageUrl).hostname.endsWith(".image.rakuten.co.jp"))) ||
    typeof identityVerified !== "boolean" ||
    (rakutenProductId !== null &&
      (typeof rakutenProductId !== "string" || !/^[a-f0-9]{32}$/i.test(rakutenProductId))) ||
    (identityVerified &&
      (rakutenProductId === null || specifications.model === null || specifications.gtin === null))
  ) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  return Object.freeze({
    ...common,
    mode: "live",
    productId: null,
    matchMethod: null,
    shopName: value["shopName"],
    price: Object.freeze({ minimum: price["minimum"], maximum: price["maximum"], currency: "JPY" }),
    tax,
    shipping,
    availability,
    expiresAt,
    affiliateUrl,
    imageUrl,
    identityVerified,
    rakutenProductId,
    specifications,
  });
}

export type ChargerUse = Readonly<{
  devices: ReadonlyArray<
    Readonly<{
      id: string;
      protocol: "pd" | "pps";
      voltageV: number;
      currentA: number;
      cable: Readonly<{ maxCurrentA: number; maxVoltageV: number }> | null;
    }>
  >;
  portPreference:
    | "ignore"
    | "prefer_roles"
    | "require_roles"
    | "prefer_numbers"
    | "require_numbers";
  plugPreference:
    | "ignore"
    | "prefer_folding"
    | "require_folding"
    | "prefer_fixed"
    | "require_fixed";
}>;

export function parseChargerUse(input: unknown): ChargerUse {
  const invalid = (): never => {
    throw new Error("端末の電圧・電流、ケーブル能力と希望条件を確認してください");
  };
  if (
    !record(input) ||
    !Array.isArray(input["devices"]) ||
    input["devices"].length < 1 ||
    input["devices"].length > 4
  ) {
    return invalid();
  }
  const portPreference = input["portPreference"];
  const plugPreference = input["plugPreference"];
  if (
    portPreference !== "ignore" &&
    portPreference !== "prefer_roles" &&
    portPreference !== "require_roles" &&
    portPreference !== "prefer_numbers" &&
    portPreference !== "require_numbers"
  ) {
    return invalid();
  }
  if (
    plugPreference !== "ignore" &&
    plugPreference !== "prefer_folding" &&
    plugPreference !== "require_folding" &&
    plugPreference !== "prefer_fixed" &&
    plugPreference !== "require_fixed"
  ) {
    return invalid();
  }
  const devices: readonly unknown[] = input["devices"];
  const decoded = devices.map((device) => {
    if (
      !record(device) ||
      typeof device["id"] !== "string" ||
      device["id"].trim().length === 0 ||
      (device["protocol"] !== "pd" && device["protocol"] !== "pps") ||
      typeof device["voltageV"] !== "number" ||
      !Number.isFinite(device["voltageV"]) ||
      device["voltageV"] <= 0 ||
      device["voltageV"] > (device["protocol"] === "pps" ? 21 : 48) ||
      typeof device["currentA"] !== "number" ||
      !Number.isFinite(device["currentA"]) ||
      device["currentA"] <= 0 ||
      device["currentA"] > 5
    ) {
      return invalid();
    }
    const cable = device["cable"];
    let verifiedCable: ChargerUse["devices"][number]["cable"] = null;
    if (cable !== null) {
      if (
        !record(cable) ||
        typeof cable["maxCurrentA"] !== "number" ||
        !Number.isFinite(cable["maxCurrentA"]) ||
        cable["maxCurrentA"] <= 0 ||
        cable["maxCurrentA"] > 5 ||
        typeof cable["maxVoltageV"] !== "number" ||
        !Number.isFinite(cable["maxVoltageV"]) ||
        cable["maxVoltageV"] <= 0 ||
        cable["maxVoltageV"] > 48
      ) {
        return invalid();
      }
      verifiedCable = Object.freeze({
        maxCurrentA: cable["maxCurrentA"],
        maxVoltageV: cable["maxVoltageV"],
      });
    }
    return Object.freeze({
      id: device["id"].trim(),
      protocol: device["protocol"],
      voltageV: device["voltageV"],
      currentA: device["currentA"],
      cable: verifiedCable,
    });
  });
  if (new Set(decoded.map((device) => device.id)).size !== decoded.length) {
    return invalid();
  }
  return Object.freeze({ devices: Object.freeze(decoded), portPreference, plugPreference });
}

type DemoComparisonProduct = Readonly<{
  official: Extract<Investigation, { mode: "official" }> | null;
  assignments: ReadonlyArray<Readonly<{ deviceId: string; port: string }>>;
  productId: string;
  title: string;
  isSource: boolean;
  status: "eligible" | "excluded" | "pending";
  rank: number | null;
  reasons: readonly string[];
  axes: ReadonlyArray<
    Readonly<{
      id: "port_operation" | "plug_storage";
      level: 0 | 1 | 2;
      source: string;
      observedAt: string;
    }>
  >;
}>;
export type ChargerComparison =
  | Readonly<{
      mode: "demo" | "official";
      notice: string;
      source: Extract<Investigation, { mode: "demo" | "official" }>;
      conditions: ChargerUse;
      status: "ranked" | "unranked" | "needs_information" | "no_match";
      policyVersion: string;
      observedAt: string;
      expiresAt: string;
      products: readonly DemoComparisonProduct[];
    }>
  | Readonly<{
      mode: "live";
      source: Extract<Investigation, { mode: "live" }>;
      conditions: ChargerUse;
      status: "needs_information";
      pending: readonly string[];
      keyword: string;
      listings: CandidateSearch["listings"];
    }>;

function validInstant(input: unknown): input is string {
  return (
    typeof input === "string" &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input
  );
}
function publicHttps(input: unknown): input is string {
  if (typeof input !== "string" || !URL.canParse(input)) {
    return false;
  }
  const url = new URL(input);
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
}

export function parseChargerComparison(input: unknown): ChargerComparison {
  if (record(input) && input["tag"] === "err") {
    parseInvestigation(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (!record(value)) {
    throw new Error("比較結果を検証できませんでした");
  }
  const source = parseInvestigation({ tag: "ok", value: value["source"] });
  const conditions = parseChargerUse(value["conditions"]);
  if (value["mode"] === "live" && source.mode === "live") {
    const search = parseCandidateSearch(input);
    const pending = value["pending"];
    if (
      value["status"] !== "needs_information" ||
      search.listings.length > 5 ||
      search.listings.some(
        (listing) =>
          listing.listingId === source.listingId || listing.canonicalUrl === source.canonicalUrl,
      ) ||
      !Array.isArray(pending) ||
      pending.length === 0 ||
      !pending.every((item: unknown) => typeof item === "string")
    ) {
      throw new Error("比較候補を検証できませんでした");
    }
    const checked: readonly unknown[] = pending;
    return Object.freeze({
      mode: "live",
      source,
      conditions,
      status: "needs_information",
      keyword: search.keyword,
      listings: search.listings,
      pending: Object.freeze(checked.flatMap((item) => (typeof item === "string" ? [item] : []))),
    });
  }
  if (
    (value["mode"] !== "demo" && value["mode"] !== "official") ||
    source.mode !== value["mode"] ||
    typeof value["notice"] !== "string" ||
    value["policyVersion"] !== "usb-c-confirmed-features-v1" ||
    !validInstant(value["observedAt"]) ||
    !validInstant(value["expiresAt"]) ||
    value["expiresAt"] <= value["observedAt"] ||
    (value["status"] !== "ranked" &&
      value["status"] !== "unranked" &&
      value["status"] !== "needs_information" &&
      value["status"] !== "no_match") ||
    !Array.isArray(value["products"]) ||
    value["products"].length < 1 ||
    value["products"].length > 6
  ) {
    throw new Error("比較結果を検証できませんでした");
  }
  const products: readonly unknown[] = value["products"];
  const resultObservedAt = value["observedAt"];
  const resultExpiresAt = value["expiresAt"];
  const decoded: DemoComparisonProduct[] = products.map((product) => {
    if (
      !record(product) ||
      typeof product["productId"] !== "string" ||
      typeof product["title"] !== "string" ||
      typeof product["isSource"] !== "boolean" ||
      (product["status"] !== "eligible" &&
        product["status"] !== "excluded" &&
        product["status"] !== "pending") ||
      (product["rank"] !== null &&
        (typeof product["rank"] !== "number" ||
          !Number.isSafeInteger(product["rank"]) ||
          product["rank"] < 1 ||
          product["rank"] > 6)) ||
      ((value["status"] !== "ranked" || product["status"] !== "eligible") &&
        product["rank"] !== null) ||
      (value["status"] === "ranked" &&
        product["status"] === "eligible" &&
        product["rank"] === null) ||
      !Array.isArray(product["reasons"]) ||
      !product["reasons"].every((reason: unknown) => typeof reason === "string") ||
      !Array.isArray(product["axes"]) ||
      product["axes"].length > 2
    ) {
      throw new Error("比較結果を検証できませんでした");
    }
    const axes: readonly unknown[] = product["axes"];
    const decodedAxes = axes.map((axis) => {
      if (
        !record(axis) ||
        (axis["id"] !== "port_operation" && axis["id"] !== "plug_storage") ||
        (axis["level"] !== 0 && axis["level"] !== 1 && axis["level"] !== 2) ||
        !publicHttps(axis["source"]) ||
        !validInstant(axis["observedAt"])
      ) {
        throw new Error("比較根拠を検証できませんでした");
      }
      return Object.freeze({
        id: axis["id"],
        level: axis["level"],
        source: axis["source"],
        observedAt: axis["observedAt"],
      });
    });
    if (new Set(decodedAxes.map((axis) => axis.id)).size !== decodedAxes.length) {
      throw new Error("比較根拠が重複しています");
    }
    const reasons: readonly unknown[] = product["reasons"];
    let official: DemoComparisonProduct["official"] = null;
    let assignments: DemoComparisonProduct["assignments"] = [];
    if (value["mode"] === "official") {
      const verified = parseInvestigation({ tag: "ok", value: product["official"] });
      if (
        verified.mode !== "official" ||
        verified.productId !== product["productId"] ||
        verified.observedAt > resultObservedAt ||
        verified.expiresAt < resultExpiresAt ||
        decodedAxes.some(
          (axis) =>
            axis.source !== verified.canonicalUrl || axis.observedAt !== verified.observedAt,
        ) ||
        !Array.isArray(product["assignments"])
      ) {
        throw new Error("公式比較の根拠を検証できませんでした");
      }
      official = verified;
      if (product["isSource"] && JSON.stringify(verified) !== JSON.stringify(source)) {
        throw new Error("入力製品と比較根拠が一致しません");
      }
      const rawAssignments: readonly unknown[] = product["assignments"];
      assignments = rawAssignments.map((assignment) => {
        if (
          !record(assignment) ||
          typeof assignment["deviceId"] !== "string" ||
          !conditions.devices.some((device) => device.id === assignment["deviceId"]) ||
          typeof assignment["port"] !== "string" ||
          !/^C[1-4]$/.test(assignment["port"]) ||
          Number(assignment["port"].slice(1)) > verified.portCount
        ) {
          throw new Error("接続先を検証できませんでした");
        }
        return Object.freeze({ deviceId: assignment["deviceId"], port: assignment["port"] });
      });
      if (
        new Set(assignments.map((assignment) => assignment.deviceId)).size !== assignments.length ||
        new Set(assignments.map((assignment) => assignment.port)).size !== assignments.length ||
        (assignments.length !== 0 && assignments.length !== conditions.devices.length) ||
        (product["status"] === "eligible" && assignments.length !== conditions.devices.length)
      ) {
        throw new Error("端末への割り当てを検証できませんでした");
      }
    }
    return Object.freeze({
      official,
      assignments: Object.freeze(assignments),
      productId: product["productId"],
      title: product["title"],
      isSource: product["isSource"],
      status: product["status"],
      rank: product["rank"],
      axes: Object.freeze(decodedAxes),
      reasons: Object.freeze(
        reasons.flatMap((reason) => (typeof reason === "string" ? [reason] : [])),
      ),
    });
  });
  if (
    new Set(decoded.map((product) => product.productId)).size !== decoded.length ||
    decoded.filter((product) => product.isSource && product.productId === source.productId)
      .length !== 1 ||
    decoded.filter((product) => product.isSource).length !== 1 ||
    (value["status"] === "ranked" && decoded.some((product) => product.status === "pending"))
  ) {
    throw new Error("比較対象を検証できませんでした");
  }
  const preferences = {
    port_operation: conditions.portPreference,
    plug_storage: conditions.plugPreference,
  };
  const observedAt = value["observedAt"];
  const activeCount = Object.values(preferences).filter(
    (preference) => preference !== "ignore",
  ).length;
  if (
    (value["status"] === "ranked" &&
      (activeCount === 0 || !decoded.some((product) => product.status === "eligible"))) ||
    (value["status"] === "no_match" &&
      !decoded.every((product) => product.status === "excluded")) ||
    (value["status"] === "needs_information" &&
      !decoded.some((product) => product.status === "pending")) ||
    (value["status"] === "unranked" &&
      (activeCount !== 0 ||
        !decoded.some((product) => product.status === "eligible") ||
        decoded.some((product) => product.status === "pending"))) ||
    decoded.some(
      (product) =>
        product.axes.some(
          (axis) => preferences[axis.id] === "ignore" || axis.observedAt > observedAt,
        ) ||
        (product.status === "eligible" &&
          (product.axes.length !== activeCount ||
            product.reasons.length !== 0 ||
            product.axes.some(
              (axis) => preferences[axis.id].startsWith("require_") && axis.level !== 2,
            ))),
    )
  ) {
    throw new Error("比較条件と結果が一致しません");
  }
  if (value["status"] === "ranked") {
    const score = (product: DemoComparisonProduct): number =>
      product.axes.reduce((sum, axis) => sum + axis.level, 0);
    const eligible = decoded.filter((product) => product.status === "eligible");
    if (
      eligible.some(
        (product) =>
          product.rank !== 1 + eligible.filter((other) => score(other) > score(product)).length,
      )
    ) {
      throw new Error("比較軸と順位が一致しません");
    }
  }
  return Object.freeze({
    mode: value["mode"],
    notice: value["notice"],
    source,
    conditions,
    status: value["status"],
    policyVersion: value["policyVersion"],
    observedAt: value["observedAt"],
    expiresAt: value["expiresAt"],
    products: Object.freeze(decoded),
  });
}

export async function compareChargers(
  source: Investigation,
  conditions: ChargerUse,
  notes: string,
  options: Readonly<{ keyword?: string; accessToken?: string }> = {},
): Promise<ChargerComparison> {
  const checked = parseChargerUse(conditions);
  if (notes.length > 200) {
    throw new Error("補足条件は200文字以内で入力してください");
  }
  if (source.mode !== "demo" && source.expiresAt <= new Date().toISOString()) {
    throw new Error("入力商品の表示期限が切れました。再取得してください");
  }
  const input = {
    url: source.canonicalUrl,
    keyword:
      options.keyword === undefined || options.keyword.trim().length === 0
        ? null
        : options.keyword.trim(),
    conditions: checked,
    confirmed: true,
    ...(source.mode !== "live"
      ? { operation: "compare" }
      : { requirements: notes.trim().length === 0 ? "USB-C充電器" : notes.trim() }),
  };
  const comparison = parseChargerComparison(
    await postApi(
      source.mode !== "live" ? "/api/investigate" : "/api/candidates",
      input,
      options.accessToken ?? "",
    ),
  );
  if (
    comparison.source.canonicalUrl !== source.canonicalUrl ||
    comparison.source.listingId !== source.listingId ||
    comparison.source.productId !== source.productId ||
    comparison.mode !== source.mode ||
    JSON.stringify(comparison.conditions) !== JSON.stringify(checked)
  ) {
    throw new Error("比較対象や条件が変わりました。入力商品を確認して再試行してください");
  }
  return comparison;
}

export async function investigateProduct(
  url: string,
  options: Readonly<{ keyword?: string; accessToken?: string }> = {},
): Promise<Investigation> {
  return parseInvestigation(
    await postApi(
      "/api/investigate",
      {
        url,
        keyword:
          options.keyword === undefined || options.keyword.trim().length === 0
            ? null
            : options.keyword.trim(),
      },
      options.accessToken ?? "",
    ),
  );
}

async function postApi(
  path: "/api/investigate" | "/api/candidates" | "/api/monitors",
  input: unknown,
  accessToken: string,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken.length > 0) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(accessToken)) {
      throw new Error("動作確認用トークンの形式を確認してください");
    }
    headers["authorization"] = `Bearer ${accessToken}`;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(95_000),
  });
  if (response.headers.get("content-type")?.includes("application/json") !== true) {
    throw new Error("商品APIが未接続です。APIの公開と /api/* の接続設定を確認してください");
  }
  const body: unknown = await response.json();
  return body;
}

export type CandidateSearch = Readonly<{
  keyword: string;
  listings: ReadonlyArray<Extract<Investigation, { mode: "live" }>>;
}>;

export function parseCandidateSearch(input: unknown): CandidateSearch {
  if (record(input) && input["tag"] === "err") {
    parseInvestigation(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (
    !record(value) ||
    typeof value["keyword"] !== "string" ||
    value["keyword"].trim().length === 0 ||
    new TextEncoder().encode(value["keyword"]).length > 128 ||
    !Array.isArray(value["listings"]) ||
    value["listings"].length > 6
  ) {
    throw new Error("候補データを検証できませんでした");
  }
  const listings: readonly unknown[] = value["listings"];
  const decoded = listings.map((entry) => {
    const listing = parseInvestigation({ tag: "ok", value: entry });
    if (listing.mode !== "live" || listing.availability !== "available") {
      throw new Error("候補データを検証できませんでした");
    }
    return listing;
  });
  if (
    new Set(decoded.map((entry) => entry.listingId)).size !== decoded.length ||
    new Set(decoded.map((entry) => entry.canonicalUrl)).size !== decoded.length
  ) {
    throw new Error("候補データが重複しています");
  }
  return Object.freeze({ keyword: value["keyword"], listings: Object.freeze(decoded) });
}

export type ProductComparisonMode = "price" | "performance" | "ai";
export type ProductComparison = Readonly<{
  mode: "live";
  comparisonMode: ProductComparisonMode;
  source: Extract<Investigation, { mode: "live" }>;
  keyword: string;
  listings: CandidateSearch["listings"];
  status: "ranked" | "needs_information" | "no_match";
  pending: readonly string[];
  scoreBasis: "relative-specification-index-v1";
  products: ReadonlyArray<
    Extract<Investigation, { mode: "live" }> &
      Readonly<{
        rank: number | null;
        recommendationPercent: number | null;
        axes: ReadonlyArray<
          Readonly<{ id: "price" | "power" | "portability" | "warranty"; score: number | null }>
        >;
        reasons: readonly string[];
      }>
  >;
}>;

function parseProductComparison(input: unknown): ProductComparison {
  const search = parseCandidateSearch(input);
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (
    !record(value) ||
    value["mode"] !== "live" ||
    (value["comparisonMode"] !== "price" &&
      value["comparisonMode"] !== "performance" &&
      value["comparisonMode"] !== "ai") ||
    (value["status"] !== "ranked" &&
      value["status"] !== "needs_information" &&
      value["status"] !== "no_match") ||
    value["scoreBasis"] !== "relative-specification-index-v1" ||
    !Array.isArray(value["products"]) ||
    value["products"].length > 5 ||
    !Array.isArray(value["pending"]) ||
    !value["pending"].every((entry: unknown) => typeof entry === "string")
  ) {
    throw new Error("比較結果を検証できませんでした");
  }
  const source = parseInvestigation({ tag: "ok", value: value["source"] });
  if (source.mode !== "live") {
    throw new Error("入力商品を検証できませんでした");
  }
  if (value["status"] === "ranked" && !source.identityVerified) {
    throw new Error("入力商品の型番が未確認です");
  }
  const raw: readonly unknown[] = value["products"];
  const products = raw.map((entry) => {
    if (
      !record(entry) ||
      !Array.isArray(entry["axes"]) ||
      !Array.isArray(entry["reasons"]) ||
      !entry["reasons"].every((reason: unknown) => typeof reason === "string")
    ) {
      throw new Error("比較項目を検証できませんでした");
    }
    const listing = parseInvestigation({ tag: "ok", value: entry });
    if (
      listing.mode !== "live" ||
      !search.listings.some((item) => JSON.stringify(item) === JSON.stringify(listing)) ||
      listing.canonicalUrl === source.canonicalUrl
    ) {
      throw new Error("比較対象を検証できませんでした");
    }
    const rank = entry["rank"];
    const percent = entry["recommendationPercent"];
    if (
      (rank !== null &&
        (typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1 || rank > 5)) ||
      (percent !== null &&
        (typeof percent !== "number" ||
          !Number.isInteger(percent) ||
          percent < 0 ||
          percent > 100)) ||
      ((value["status"] !== "ranked" || !listing.identityVerified) &&
        (rank !== null || percent !== null)) ||
      (value["status"] === "ranked" && (rank === null || percent === null))
    ) {
      throw new Error("順位を検証できませんでした");
    }
    const axes: readonly unknown[] = entry["axes"];
    const decoded = axes.map((axis) => {
      if (
        !record(axis) ||
        (axis["id"] !== "price" &&
          axis["id"] !== "power" &&
          axis["id"] !== "portability" &&
          axis["id"] !== "warranty") ||
        (axis["score"] !== null &&
          (typeof axis["score"] !== "number" ||
            !Number.isInteger(axis["score"]) ||
            axis["score"] < 0 ||
            axis["score"] > 100))
      ) {
        throw new Error("評価軸を検証できませんでした");
      }
      return Object.freeze({ id: axis["id"], score: axis["score"] });
    });
    const expected =
      value["comparisonMode"] === "price"
        ? ["price"]
        : value["comparisonMode"] === "performance"
          ? ["power"]
          : ["price", "power", "portability", "warranty"];
    if (
      JSON.stringify(decoded.map((axis) => axis.id)) !== JSON.stringify(expected) ||
      (percent !== null &&
        (decoded.some((axis) => axis.score === null) ||
          Math.round(decoded.reduce((sum, axis) => sum + (axis.score ?? 0), 0) / decoded.length) !==
            percent))
    ) {
      throw new Error("評価の根拠が一致しません");
    }
    const reasons: readonly unknown[] = entry["reasons"];
    return Object.freeze({
      ...listing,
      rank,
      recommendationPercent: percent,
      axes: Object.freeze(decoded),
      reasons: Object.freeze(
        reasons.flatMap((reason) => (typeof reason === "string" ? [reason] : [])),
      ),
    });
  });
  if (
    products.length !== search.listings.length ||
    new Set(products.map((product) => product.listingId)).size !== products.length ||
    (value["status"] === "no_match") !== (products.length === 0) ||
    (value["status"] === "ranked" &&
      (products.length < 2 ||
        products.some(
          (product) =>
            product.rank !==
            1 +
              products.filter((other) =>
                value["comparisonMode"] === "price"
                  ? other.price.minimum < product.price.minimum
                  : value["comparisonMode"] === "performance"
                    ? (other.specifications.maxPowerW ?? 0) >
                      (product.specifications.maxPowerW ?? 0)
                    : (other.recommendationPercent ?? 0) > (product.recommendationPercent ?? 0),
              ).length,
        )))
  ) {
    throw new Error("比較順位が一致しません");
  }
  const pending: readonly unknown[] = value["pending"];
  return Object.freeze({
    mode: "live",
    comparisonMode: value["comparisonMode"],
    source,
    ...search,
    status: value["status"],
    pending: Object.freeze(pending.flatMap((entry) => (typeof entry === "string" ? [entry] : []))),
    scoreBasis: "relative-specification-index-v1",
    products: Object.freeze(products),
  });
}

export async function compareProducts(
  source: Extract<Investigation, { mode: "live" }>,
  mode: ProductComparisonMode,
  requirements: string,
  options: Readonly<{ keyword?: string; accessToken?: string }> = {},
): Promise<ProductComparison> {
  if (source.expiresAt <= new Date().toISOString()) {
    throw new Error("入力商品の表示期限が切れました。再取得してください");
  }
  const result = parseProductComparison(
    await postApi(
      "/api/candidates",
      {
        url: source.canonicalUrl,
        keyword:
          options.keyword === undefined || options.keyword.trim().length === 0
            ? null
            : options.keyword.trim(),
        comparisonMode: mode,
        requirements:
          requirements.trim().length === 0 ? "入力商品と同じ用途の類似商品" : requirements.trim(),
      },
      options.accessToken ?? "",
    ),
  );
  if (
    result.source.canonicalUrl !== source.canonicalUrl ||
    result.source.listingId !== source.listingId ||
    result.comparisonMode !== mode
  ) {
    throw new Error("比較対象が変わりました。再取得してください");
  }
  return result;
}
