import { requestJson } from "./transport.js";

type ApiError = Readonly<{
  code:
    | "invalid_request"
    | "not_configured"
    | "listing_not_found"
    | "provider_unavailable"
    | "provider_unauthorized"
    | "provider_rate_limited"
    | "invalid_response";
}>;
type Result<T> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "err"; error: ApiError }>;
type Product = Readonly<{
  ecCode: string;
  productCode: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  guid: string;
  link: string;
  price: number;
  stock: 0 | 1 | 2 | 3 | null;
}>;
type Query = Readonly<{
  operation: "search" | "lookup";
  query: string;
  page?: number;
  limit?: number;
}>;
type Client = Readonly<{
  getAffiliateLink: (productId: string, signal?: AbortSignal) => Promise<Result<string>>;
  request: (
    query: Query,
    signal?: AbortSignal,
  ) => Promise<
    Result<Readonly<{ items: readonly Product[]; total: number; page: number; limit: number }>>
  >;
}>;
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function failure(code: ApiError["code"]): Result<never> {
  return Object.freeze({ tag: "err", error: Object.freeze({ code }) });
}
function string(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= maximum;
}
function natural(input: unknown): number | null {
  const value = typeof input === "string" && /^\d+(?:\.\d+)?$/u.test(input) ? Number(input) : input;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stockValue(input: unknown): Product["stock"] {
  if (input === "なし") {
    return 0;
  }
  if (input === "在庫有り") {
    return 1;
  }
  if (input === "お取り寄せ") {
    return 2;
  }
  if (input === "予約受付") {
    return 3;
  }
  const value = natural(input);
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : null;
}

function productImage(input: unknown): string | null {
  if (!record(input) || !string(input["url"], 2048)) {
    return null;
  }
  try {
    const url = new URL(input["url"]);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/iu.test(url.hostname) &&
      !/\.(?:localhost|local|internal|test|invalid|example)$/iu.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The Satofull integration uses this official ValueCommerce product API, not a direct Satofull API. */
export function createValueCommerceClient(
  configuration: Readonly<{ token: string; advertiserCode: string }>,
  fetcher: typeof fetch = fetch,
): Client {
  if (
    !string(configuration.token, 256) ||
    new TextEncoder().encode(configuration.token).length > 256 ||
    /[\s\p{Cc}]/u.test(configuration.token) ||
    !/^[a-zA-Z0-9]{1,50}$/u.test(configuration.advertiserCode)
  ) {
    throw new Error("Invalid ValueCommerce API credentials");
  }
  const client: Client = Object.freeze({
    async getAffiliateLink(productId, signal) {
      const result = await client.request(
        { operation: "lookup", query: productId, limit: 1 },
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      const item = result.value.items[0];
      if (item === undefined) {
        return failure("listing_not_found");
      }
      try {
        const link = new URL(item.link),
          destination = new URL(item.guid);
        if (
          item.productCode !== productId ||
          link.protocol !== "https:" ||
          link.hostname !== "ck.jp.ap.valuecommerce.com" ||
          link.pathname !== "/servlet/referral" ||
          link.username !== "" ||
          link.password !== "" ||
          link.port !== "" ||
          destination.protocol !== "https:" ||
          destination.username !== "" ||
          destination.password !== "" ||
          destination.port !== "" ||
          productImage({ url: destination.href }) === null ||
          link.hash !== "" ||
          destination.hash !== "" ||
          link.searchParams.getAll("vc_url").length !== 1 ||
          link.searchParams.get("vc_url") !== destination.href
        ) {
          return failure("invalid_response");
        }
        for (const keys of [
          ["sid", "vs"],
          ["pid", "vp"],
        ]) {
          const values = keys.flatMap((key) => link.searchParams.getAll(key));
          if (values.length !== 1 || !/^\d{1,20}$/u.test(values[0] ?? "")) {
            return failure("invalid_response");
          }
        }
        return { tag: "ok", value: link.href };
      } catch {
        return failure("invalid_response");
      }
    },
    async request(query, signal) {
      const page = query.page ?? 1,
        limit = query.limit ?? (query.operation === "lookup" ? 1 : 20);
      if (
        !["search", "lookup"].includes(query.operation) ||
        !string(query.query, query.operation === "lookup" ? 300 : 256) ||
        query.query.trim().length === 0 ||
        /\p{Cc}/u.test(query.query) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (query.operation === "lookup" && page !== 1)
      ) {
        return failure("invalid_request");
      }
      const endpoint = new URL("https://webservice.valuecommerce.ne.jp/productdb/search");
      endpoint.search = new URLSearchParams({
        token: configuration.token,
        ec_code: configuration.advertiserCode,
        format: "json",
        page: String(page),
        results_per_page: String(limit),
        [query.operation === "lookup" ? "product_id" : "keyword"]: query.query,
      }).toString();
      const result = await requestJson(fetcher, endpoint, signal);
      if (result.tag === "err") {
        return result;
      }
      const body = result.value;
      if (!record(body)) {
        return failure("invalid_response");
      }
      if (body["status"] === "INVALID_TOKEN") {
        return failure("provider_unauthorized");
      }
      if (body["status"] === "INVALID_CONFIGURATION") {
        return failure("not_configured");
      }
      if (
        body["status"] === "INVALID_SEARCH_PARAMETERS" ||
        body["status"] === "INVALID_SEARCH_VALUE"
      ) {
        return failure("invalid_request");
      }
      if (body["status"] === "SERVICE_UNAVAILABLE" || body["status"] === "INTERNAL_SERVER_ERROR") {
        return failure("provider_unavailable");
      }
      const total = natural(body["resultCount"]);
      if (
        body["status"] !== "OK" ||
        total === null ||
        !Array.isArray(body["items"]) ||
        body["items"].length > limit
      ) {
        return failure("invalid_response");
      }
      const raw: readonly unknown[] = body["items"];
      const items: Product[] = [];
      for (const item of raw) {
        if (!record(item)) {
          return failure("invalid_response");
        }
        const price = natural(item["price"]);
        const description = item["description"] ?? null;
        if (
          item["ecCode"] !== configuration.advertiserCode ||
          !string(item["productCode"], 300) ||
          !string(item["title"], 256) ||
          !string(item["guid"], 2048) ||
          !string(item["link"], 2048) ||
          price === null ||
          price === 0 ||
          (query.operation === "lookup" && item["productCode"] !== query.query) ||
          (description !== null && (typeof description !== "string" || description.length > 4096))
        ) {
          return failure("invalid_response");
        }
        items.push(
          Object.freeze({
            ecCode: configuration.advertiserCode,
            productCode: item["productCode"],
            title: item["title"],
            description,
            imageUrl:
              productImage(item["imageLarge"]) ??
              productImage(item["imageFree"]) ??
              productImage(item["imageSmall"]),
            guid: item["guid"],
            link: item["link"],
            price,
            stock: stockValue(item["stock"]),
          }),
        );
      }
      return Object.freeze({
        tag: "ok",
        value: Object.freeze({ items: Object.freeze(items), total, page, limit }),
      });
    },
  });
  return client;
}

/** Pins the official advertiser code; product IDs remain ValueCommerce IDs. */
export function createSatofullClient(
  configuration: Readonly<{ token: string }>,
  fetcher: typeof fetch = fetch,
): Client {
  return createValueCommerceClient(
    { token: configuration.token, advertiserCode: "jbfh4" },
    fetcher,
  );
}
