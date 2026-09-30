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
      }>
  );

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
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
      provider_unauthorized: "楽天のアプリID・アクセスキー・許可ドメインを確認してください",
      provider_rate_limited: "楽天APIの利用制限に達しました。時間をおいて再試行してください",
      provider_unavailable: "楽天APIに接続できませんでした。時間をおいて再試行してください",
      listing_not_found: "掲載を取得できませんでした。接続設定に商品名を入力して再試行してください",
      lookup_incomplete:
        "検索結果が多いため掲載を確認できません。接続設定の商品名を絞って再試行してください",
      ambiguous_listing: "掲載URLに一致する結果が複数あり、確定できませんでした",
      source_not_authorized:
        "商品データの取得・表示許諾が期限切れです。サーバー設定を確認してください",
      unsupported_url: "楽天市場の商品URL（item.rakuten.co.jp）を入力してください",
      invalid_url: "商品URLを確認してください",
      invalid_request: "商品URLと補助の商品名（UTF-8で128バイト以内）を確認してください",
      invalid_keyword: "接続設定に商品名を入力してください（UTF-8で128バイト以内）",
      invalid_data: "楽天APIの応答を検証できませんでした",
      storage_unavailable: "実行記録を保存できませんでした。時間をおいて再試行してください",
      method_not_allowed: "APIの呼び出し方法が対応していません",
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
    (value["mode"] !== "demo" && value["mode"] !== "live") ||
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
    expiresAt <= common.observedAt
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
  });
}

export async function investigateProduct(
  url: string,
  options: Readonly<{ keyword?: string; accessToken?: string }> = {},
): Promise<Investigation> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.accessToken !== undefined && options.accessToken.length > 0) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.accessToken)) {
      throw new Error("動作確認用トークンの形式を確認してください");
    }
    headers["authorization"] = `Bearer ${options.accessToken}`;
  }
  const response = await fetch("/api/investigate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url,
      keyword:
        options.keyword === undefined || options.keyword.trim().length === 0
          ? null
          : options.keyword.trim(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.headers.get("content-type")?.includes("application/json") !== true) {
    throw new Error("商品APIが未接続です。APIの公開と /api/* の接続設定を確認してください");
  }
  const body: unknown = await response.json();
  return parseInvestigation(body);
}
