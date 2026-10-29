import { authHeaders, readJsonResponse, resolveApiBase } from "./consumer-http.js";
import type { ApiRequestOptions } from "./consumer-http.js";
import { parseFurusatoComparison } from "./furusato.js";
import type { FurusatoComparison, FurusatoComparisonRequest } from "./furusato.js";

export type CommerceSource = "rakuten" | "yahoo" | "amazon" | "rakuten_furusato" | "satofull";
export type CommerceRequest = Readonly<{
  source: CommerceSource;
  operation: "search" | "lookup";
  query: string;
  page?: number;
  limit?: number;
}>;
export type CommerceListing = Readonly<{
  source: CommerceSource;
  id: string;
  title: string;
  url: string;
  affiliateUrl: string;
  description: string | null;
  imageUrl: string | null;
  amount: Readonly<{
    minimum: number;
    maximum: number;
    currency: "JPY";
    kind: "purchase" | "donation";
  }> | null;
  priceBasis: "listing" | "featured_offer";
  condition: "new" | "used" | "refurbished" | "unknown" | "not_applicable";
  availability: "available" | "unavailable" | "unknown";
  shipping: "included" | "excluded" | "unknown";
  tax: "included" | "excluded" | "unknown";
  observedAt: string;
  expiresAt: string;
  usage: Readonly<{ ai: boolean; priceComparison: boolean; store: false }>;
  notices: readonly string[];
}>;
export type CommercePage = Readonly<{
  listings: readonly CommerceListing[];
  total: number | null;
  page: number;
  limit: number;
  furusato: FurusatoComparison | null;
}>;
export type CommerceSourceStatus = Readonly<{
  id: CommerceSource;
  label: string;
  configured: boolean;
}>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function source(input: unknown): input is CommerceSource {
  return (
    input === "rakuten" ||
    input === "yahoo" ||
    input === "amazon" ||
    input === "rakuten_furusato" ||
    input === "satofull"
  );
}

function operation(input: unknown): input is CommerceRequest["operation"] {
  return input === "search" || input === "lookup";
}

function text(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.trim().length > 0 && input.length <= maximum;
}

function natural(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function invalid(): Error {
  return new Error("商品取得APIの応答を検証できませんでした", {
    cause: { code: "invalid_response" },
  });
}

function valueOfResponse(input: unknown): Record<string, unknown> {
  if (!record(input) || input["tag"] !== "ok" || !record(input["value"])) {
    throw invalid();
  }
  return input["value"];
}

function checkedUrl(input: unknown, host: string): URL {
  if (!text(input, 4096)) {
    throw invalid();
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw invalid();
  }
  return url;
}

function parseAmount(input: unknown, donation: boolean): CommerceListing["amount"] {
  if (input === null) {
    return null;
  }
  if (
    !record(input) ||
    !natural(input["minimum"]) ||
    !natural(input["maximum"]) ||
    input["minimum"] <= 0 ||
    input["minimum"] > input["maximum"] ||
    input["currency"] !== "JPY" ||
    input["kind"] !== (donation ? "donation" : "purchase")
  ) {
    throw invalid();
  }
  return Object.freeze({
    minimum: input["minimum"],
    maximum: input["maximum"],
    currency: "JPY",
    kind: donation ? "donation" : "purchase",
  });
}

function parseListing(input: unknown, expected: CommerceSource, now: number): CommerceListing {
  if (
    !record(input) ||
    input["source"] !== expected ||
    !text(input["id"], 300) ||
    !text(input["title"], 2000) ||
    (input["description"] !== null &&
      (typeof input["description"] !== "string" || input["description"].length > 65536)) ||
    typeof input["observedAt"] !== "string" ||
    typeof input["expiresAt"] !== "string"
  ) {
    throw invalid();
  }
  const observed = Date.parse(input["observedAt"]);
  const expires = Date.parse(input["expiresAt"]);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now + 30_000 ||
    expires <= now ||
    expires <= observed ||
    expires > observed + 900_000
  ) {
    throw invalid();
  }
  const donation = expected === "satofull" || expected === "rakuten_furusato";
  let imageUrl: string | null = null;
  if (input["imageUrl"] !== undefined && input["imageUrl"] !== null) {
    if (!text(input["imageUrl"], 4096)) {
      throw invalid();
    }
    let image: URL;
    try {
      image = new URL(input["imageUrl"]);
    } catch {
      throw invalid();
    }
    if (
      image.protocol !== "https:" ||
      image.username !== "" ||
      image.password !== "" ||
      (image.port !== "" && image.port !== "443") ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/iu.test(image.hostname) ||
      /\.(?:localhost|local|internal|test|invalid|example)$/iu.test(image.hostname)
    ) {
      throw invalid();
    }
    imageUrl = image.href;
  }
  const amazon = expected === "amazon";
  const rakuten = expected === "rakuten" || expected === "rakuten_furusato";
  const url = checkedUrl(
    input["url"],
    amazon
      ? "www.amazon.co.jp"
      : rakuten
        ? "item.rakuten.co.jp"
        : expected === "satofull"
          ? "www.satofull.jp"
          : "store.shopping.yahoo.co.jp",
  );
  const affiliate = checkedUrl(
    input["affiliateUrl"],
    amazon ? "www.amazon.co.jp" : rakuten ? "hb.afl.rakuten.co.jp" : "ck.jp.ap.valuecommerce.com",
  );
  if (amazon) {
    if (
      !/^[A-Z0-9]{10}$/.test(input["id"]) ||
      url.pathname !== `/dp/${input["id"]}` ||
      /^\/(?:dp|gp\/product)\/([A-Z0-9]{10})\/?$/u.exec(affiliate.pathname)?.[1] !== input["id"] ||
      affiliate.searchParams.getAll("tag").length !== 1 ||
      !/^[a-zA-Z0-9_-]+-22$/.test(affiliate.searchParams.get("tag") ?? "")
    ) {
      throw invalid();
    }
  } else if (rakuten) {
    if (
      !/^\/hgc\/[a-fA-F0-9.]+\/$/.test(affiliate.pathname) ||
      affiliate.searchParams.getAll("pc").length !== 1 ||
      affiliate.searchParams.get("pc") !== url.href
    ) {
      throw invalid();
    }
  } else {
    if (
      affiliate.pathname !== "/servlet/referral" ||
      affiliate.searchParams.getAll("vc_url").length !== 1 ||
      affiliate.searchParams.get("vc_url") !== url.href
    ) {
      throw invalid();
    }
  }
  const usage = input["usage"];
  const condition = input["condition"];
  const availability = input["availability"];
  const shipping = input["shipping"];
  const tax = input["tax"];
  const notices = input["notices"];
  const basis = input["priceBasis"];
  if (
    !record(usage) ||
    typeof usage["ai"] !== "boolean" ||
    typeof usage["priceComparison"] !== "boolean" ||
    usage["store"] !== false ||
    (basis !== "listing" && basis !== "featured_offer") ||
    (condition !== "new" &&
      condition !== "used" &&
      condition !== "refurbished" &&
      condition !== "unknown" &&
      condition !== "not_applicable") ||
    donation !== (condition === "not_applicable") ||
    (availability !== "available" &&
      availability !== "unavailable" &&
      availability !== "unknown") ||
    (shipping !== "included" && shipping !== "excluded" && shipping !== "unknown") ||
    (tax !== "included" && tax !== "excluded" && tax !== "unknown") ||
    !Array.isArray(notices) ||
    notices.length > 8 ||
    notices.length === 0 ||
    (amazon &&
      (usage["ai"] ||
        usage["priceComparison"] ||
        input["description"] !== null ||
        basis !== "featured_offer")) ||
    (!amazon && basis !== "listing")
  ) {
    throw invalid();
  }
  const messages: string[] = [];
  const rawMessages: readonly unknown[] = notices;
  for (const item of rawMessages) {
    if (!text(item, 2000)) {
      throw invalid();
    }
    messages.push(item);
  }
  return Object.freeze({
    source: expected,
    id: input["id"],
    title: input["title"],
    url: url.href,
    affiliateUrl: affiliate.href,
    description: input["description"],
    imageUrl,
    amount: parseAmount(input["amount"], donation),
    priceBasis: basis,
    condition,
    availability,
    shipping,
    tax,
    observedAt: input["observedAt"],
    expiresAt: input["expiresAt"],
    usage: Object.freeze({
      ai: usage["ai"],
      priceComparison: usage["priceComparison"],
      store: false,
    }),
    notices: Object.freeze(messages),
  });
}

export function parseCommercePage(
  input: unknown,
  expectedSource: CommerceSource,
  now = Date.now(),
): CommercePage {
  const value = valueOfResponse(input);
  if (
    !source(expectedSource) ||
    !Array.isArray(value["listings"]) ||
    value["listings"].length > 10 ||
    (value["total"] !== null && !natural(value["total"])) ||
    !natural(value["page"]) ||
    value["page"] < 1 ||
    value["page"] > 10 ||
    !natural(value["limit"]) ||
    value["limit"] < 1 ||
    value["limit"] > 10 ||
    value["listings"].length > value["limit"]
  ) {
    throw invalid();
  }
  const raw: readonly unknown[] = value["listings"];
  const listings = raw.map((item) => parseListing(item, expectedSource, now));
  if (new Set(listings.map((listing) => listing.id)).size !== listings.length) {
    throw invalid();
  }
  return Object.freeze({
    listings: Object.freeze(listings),
    total: value["total"],
    page: value["page"],
    limit: value["limit"],
    furusato: parseFurusatoComparison(value["furusato"], listings),
  });
}

async function request(
  path: string,
  options: ApiRequestOptions,
  body?: CommerceRequest | FurusatoComparisonRequest,
): Promise<unknown> {
  options.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(95_000);
  const response = await fetch(`${resolveApiBase(options.apiBase)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: authHeaders(options),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]),
  });
  const bodyResult = await readJsonResponse(response);
  options.signal?.throwIfAborted();
  return bodyResult;
}

export async function fetchFurusatoComparison(
  input: FurusatoComparisonRequest,
  options: ApiRequestOptions = {},
): Promise<CommercePage> {
  if (
    input.items.length < 2 ||
    input.items.length > 6 ||
    input.items.some(
      (item) =>
        !["rakuten_furusato", "satofull"].includes(item.source) ||
        !text(item.query, 2048) ||
        /\p{Cc}/u.test(item.query) ||
        new TextEncoder().encode(item.query).length > 2048,
    ) ||
    new Set(input.items.map((item) => `${item.source}:${item.query.trim()}`)).size !==
      input.items.length ||
    new TextEncoder().encode(JSON.stringify(input)).length > 4096
  ) {
    throw new Error("比較する返礼品を2〜6件指定してください");
  }
  const raw = valueOfResponse(await request("/api/furusato/compare", options, input));
  if (
    !Array.isArray(raw["listings"]) ||
    raw["listings"].length !== input.items.length ||
    raw["total"] !== input.items.length ||
    raw["page"] !== 1 ||
    raw["limit"] !== input.items.length
  ) {
    throw invalid();
  }
  const entries: readonly unknown[] = raw["listings"];
  const listings = entries.map((item, index) => {
    const expected = input.items[index];
    if (expected === undefined) {
      throw invalid();
    }
    const listing = parseListing(item, expected.source, Date.now());
    if (expected.source === "satofull" && listing.id !== expected.query.trim()) {
      throw invalid();
    }
    return listing;
  });
  if (new Set(listings.map((item) => `${item.source}:${item.id}`)).size !== listings.length) {
    throw invalid();
  }
  const furusato = parseFurusatoComparison(raw["furusato"], listings);
  if (furusato === null) {
    throw invalid();
  }
  return Object.freeze({
    listings: Object.freeze(listings),
    total: listings.length,
    page: 1,
    limit: listings.length,
    furusato,
  });
}

export async function fetchCommerceSources(
  options: ApiRequestOptions = {},
): Promise<readonly CommerceSourceStatus[]> {
  const value = valueOfResponse(await request("/api/commerce/sources", options));
  if (!Array.isArray(value["sources"]) || value["sources"].length !== 5) {
    throw invalid();
  }
  const raw: readonly unknown[] = value["sources"];
  const sources = raw.map((item): CommerceSourceStatus => {
    if (
      !record(item) ||
      !source(item["id"]) ||
      !text(item["label"], 100) ||
      typeof item["configured"] !== "boolean"
    ) {
      throw invalid();
    }
    return Object.freeze({ id: item["id"], label: item["label"], configured: item["configured"] });
  });
  if (new Set(sources.map((item) => item.id)).size !== 5) {
    throw invalid();
  }
  return Object.freeze(sources);
}

export async function fetchCommerceListings(
  input: CommerceRequest,
  options: ApiRequestOptions = {},
): Promise<CommercePage> {
  if (
    !source(input.source) ||
    !operation(input.operation) ||
    !text(input.query, 2048) ||
    /\p{Cc}/u.test(input.query) ||
    new TextEncoder().encode(input.query).length > (input.operation === "search" ? 128 : 2048) ||
    !natural(input.page ?? 1) ||
    (input.page ?? 1) < 1 ||
    (input.page ?? 1) > 10 ||
    !natural(input.limit ?? 10) ||
    (input.limit ?? 10) < 1 ||
    (input.limit ?? 10) > 10 ||
    (input.operation === "lookup" && ((input.page ?? 1) !== 1 || (input.limit ?? 10) !== 10))
  ) {
    throw new Error("取得元と検索条件を確認してください");
  }
  const page = parseCommercePage(await request("/api/commerce", options, input), input.source);
  if (
    page.page !== (input.page ?? 1) ||
    page.limit !== (input.operation === "lookup" ? 1 : (input.limit ?? 10)) ||
    (input.operation === "lookup" && page.listings.length !== 1)
  ) {
    throw invalid();
  }
  return page;
}

/** All vendors resolve links through a fresh lookup; keep expiry with the URL instead of persisting bare links. */
export async function fetchCommerceAffiliateLink(
  input: Readonly<{ source: CommerceSource; query: string }>,
  options: ApiRequestOptions = {},
): Promise<
  Readonly<
    Pick<CommerceListing, "source" | "id" | "url" | "affiliateUrl" | "observedAt" | "expiresAt">
  >
> {
  const page = await fetchCommerceListings({ ...input, operation: "lookup" }, options);
  const listing = page.listings[0];
  if (listing === undefined) {
    throw invalid();
  }
  return Object.freeze({
    source: listing.source,
    id: listing.id,
    url: listing.url,
    affiliateUrl: listing.affiliateUrl,
    observedAt: listing.observedAt,
    expiresAt: listing.expiresAt,
  });
}
