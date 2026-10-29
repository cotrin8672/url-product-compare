import { failure, natural, record, requestJson, requestText, safeUrl, text } from "./transport.js";
import type { ApiResult } from "./transport.js";
import { child, parseXml } from "./xml.js";

type Configuration = Readonly<{ applicationId: string; affiliateId?: string }>;

/** Yahoo's documented affiliate_id is an unencoded VC redirect prefix; request encoding happens once. */
export function createYahooAffiliateId(
  account: Readonly<{ siteId: string; spaceId: string }>,
): string {
  if (!/^\d{1,20}$/u.test(account.siteId) || !/^\d{1,20}$/u.test(account.spaceId)) {
    throw new Error("Invalid Yahoo affiliate account");
  }
  const prefix = new URL("https://ck.jp.ap.valuecommerce.com/servlet/referral");
  prefix.search = new URLSearchParams({
    sid: account.siteId,
    pid: account.spaceId,
    vc_url: "",
  }).toString();
  return prefix.href;
}
type Product = Readonly<{
  code: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  url: string;
  affiliateUrl: string | null;
  price: number;
  condition: "new" | "used" | "unknown";
  inStock: boolean | null;
  shippingCode: number | null;
  taxIncluded: boolean | null;
}>;
type Page = Readonly<{ items: readonly Product[]; total: number; page: number; limit: number }>;
type Query = Readonly<{
  operation: "search" | "lookup";
  query: string;
  page?: number;
  limit?: number;
  janCode?: string;
  condition?: "new" | "used";
}>;
type Client = Readonly<{
  request: (query: Query, signal?: AbortSignal) => Promise<ApiResult<Page>>;
  getAffiliateLink: (code: string, signal?: AbortSignal) => Promise<ApiResult<string>>;
}>;
function itemCode(input: string): boolean {
  return /^[a-zA-Z0-9-][a-zA-Z0-9_-]*_[a-zA-Z0-9_.%-]+$/u.test(input) && input.length <= 300;
}
function links(
  input: unknown,
  code: string,
  affiliate: URL | undefined,
): Readonly<{ url: string; affiliateUrl: string | null }> | null {
  const original = safeUrl(input, ["store.shopping.yahoo.co.jp", "ck.jp.ap.valuecommerce.com"]);
  if (original === null) {
    return null;
  }
  let destination = original;
  const tracking = original.hostname === "ck.jp.ap.valuecommerce.com";
  if (tracking && affiliate === undefined) {
    return null;
  }
  if (tracking) {
    if (
      original.pathname !== "/servlet/referral" ||
      original.searchParams.getAll("vc_url").length !== 1
    ) {
      return null;
    }
    for (const keys of [
      ["sid", "vs"],
      ["pid", "vp"],
    ]) {
      const values = keys.flatMap((key) => original.searchParams.getAll(key));
      if (
        values.length !== 1 ||
        !/^\d{1,20}$/u.test(values[0] ?? "") ||
        values[0] !== affiliate?.searchParams.get(keys[0] ?? "")
      ) {
        return null;
      }
    }
    const target = safeUrl(original.searchParams.get("vc_url"), ["store.shopping.yahoo.co.jp"]);
    if (target === null) {
      return null;
    }
    destination = target;
  }
  const match = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.%-]+)\.html$/u.exec(destination.pathname);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[1] + "_" + match[2] !== code ||
    (affiliate !== undefined && !tracking)
  ) {
    return null;
  }
  return { url: destination.href, affiliateUrl: tracking ? original.href : null };
}
function image(input: unknown): string | null {
  return safeUrl(input)?.href ?? null;
}

export function createYahooShoppingClient(
  configuration: Configuration,
  fetcher: typeof fetch = fetch,
): Client {
  const affiliate =
    configuration.affiliateId === undefined
      ? undefined
      : safeUrl(configuration.affiliateId, ["ck.jp.ap.valuecommerce.com"]);
  if (
    affiliate === null ||
    (affiliate !== undefined &&
      (affiliate.pathname !== "/servlet/referral" ||
        affiliate.hash !== "" ||
        configuration.affiliateId?.endsWith("vc_url=") !== true ||
        ["sid", "pid"].some(
          (key) =>
            affiliate.searchParams.getAll(key).length !== 1 ||
            !/^\d{1,20}$/u.test(affiliate.searchParams.get(key) ?? ""),
        ) ||
        affiliate.searchParams.getAll("vc_url").length !== 1 ||
        affiliate.searchParams.get("vc_url") !== "" ||
        affiliate.searchParams.has("vs") ||
        affiliate.searchParams.has("vp")))
  ) {
    throw new Error("Invalid Yahoo affiliate URL prefix; pass the raw URL before encoding");
  }
  if (
    !text(configuration.applicationId, 512) ||
    /\s/u.test(configuration.applicationId) ||
    (configuration.affiliateId !== undefined &&
      (!text(configuration.affiliateId, 1024) || /\s/u.test(configuration.affiliateId)))
  ) {
    throw new Error("Invalid Yahoo Shopping API credentials");
  }
  const settings = Object.freeze({ ...configuration });
  // Lookup's documented limit is one request/second. Search and lookup share the same queue.
  let previous: Promise<void> = Promise.resolve(),
    nextAt = 0;
  const paced: typeof fetch = async (input, init) => {
    const result = previous.then(async () => {
      const signal = init?.signal;
      signal?.throwIfAborted();
      const delay = nextAt - Date.now();
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new Error("Yahoo request expired"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, delay);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted === true) {
            abort();
          }
        });
      }
      signal?.throwIfAborted();
      nextAt = Date.now() + 1100;
      return await fetcher(input, init);
    });
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };
  const client: Client = {
    async request(query, signal) {
      const page = query.page ?? 1,
        limit = query.limit ?? 10;
      if (
        !["search", "lookup"].includes(query.operation) ||
        !text(query.query, query.operation === "lookup" ? 300 : 256) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (page - 1) * limit + 1 + limit > 1000 ||
        (query.operation === "lookup" &&
          (!itemCode(query.query) ||
            page !== 1 ||
            query.janCode !== undefined ||
            query.condition !== undefined)) ||
        (query.janCode !== undefined && !/^\d{8,14}$/u.test(query.janCode)) ||
        (query.condition !== undefined && !["new", "used"].includes(query.condition))
      ) {
        return failure("invalid_request");
      }
      const endpoint = new URL(
        "https://shopping.yahooapis.jp/ShoppingWebService/" +
          (query.operation === "search" ? "V3/itemSearch" : "V1/itemLookup"),
      );
      endpoint.search = new URLSearchParams({
        appid: settings.applicationId,
        image_size: "600",
        ...(settings.affiliateId === undefined
          ? {}
          : { affiliate_type: "vc", affiliate_id: settings.affiliateId }),
        ...(query.operation === "search"
          ? {
              query: query.query,
              results: String(limit),
              start: String((page - 1) * limit + 1),
              ...(query.janCode === undefined ? {} : { jan_code: query.janCode }),
              ...(query.condition === undefined ? {} : { condition: query.condition }),
            }
          : { itemcode: query.query, responsegroup: "large" }),
      }).toString();
      const items: Product[] = [];
      let total: number;
      if (query.operation === "search") {
        const result = await requestJson(paced, endpoint, {}, signal);
        if (result.tag === "err") {
          return result;
        }
        const body = result.value;
        if (
          !record(body) ||
          natural(body["totalResultsAvailable"]) === null ||
          !Array.isArray(body["hits"]) ||
          body["hits"].length > limit ||
          natural(body["totalResultsReturned"]) !== body["hits"].length ||
          natural(body["firstResultsPosition"]) !== (page - 1) * limit + 1
        ) {
          return failure("invalid_response");
        }
        total = Number(body["totalResultsAvailable"]);
        const raw: readonly unknown[] = body["hits"];
        for (const hit of raw) {
          if (
            !record(hit) ||
            !text(hit["code"], 300) ||
            !itemCode(hit["code"]) ||
            !text(hit["name"], 2000) ||
            natural(hit["price"]) === null ||
            Number(hit["price"]) <= 0 ||
            (hit["description"] !== undefined &&
              hit["description"] !== null &&
              (typeof hit["description"] !== "string" || hit["description"].length > 65536))
          ) {
            return failure("invalid_response");
          }
          const link = links(hit["url"], hit["code"], affiliate);
          if (link === null) {
            return failure("invalid_response");
          }
          const shipping = record(hit["shipping"]) ? natural(hit["shipping"]["code"]) : null;
          const taxable = record(hit["priceLabel"]) ? hit["priceLabel"]["taxable"] : undefined;
          items.push(
            Object.freeze({
              code: hit["code"],
              name: hit["name"],
              description: typeof hit["description"] === "string" ? hit["description"] : null,
              ...link,
              price: Number(hit["price"]),
              imageUrl:
                (record(hit["exImage"]) ? image(hit["exImage"]["url"]) : null) ??
                (record(hit["image"]) ? image(hit["image"]["medium"]) : null),
              condition:
                hit["condition"] === "new" || hit["condition"] === "used"
                  ? hit["condition"]
                  : "unknown",
              inStock: typeof hit["inStock"] === "boolean" ? hit["inStock"] : null,
              shippingCode: shipping === 1 || shipping === 2 || shipping === 3 ? shipping : null,
              taxIncluded: typeof taxable === "boolean" ? taxable : null,
            }),
          );
        }
      } else {
        const result = await requestText(
          paced,
          endpoint,
          { headers: { accept: "application/xml" } },
          signal,
        );
        if (result.tag === "err") {
          return result;
        }
        const root = parseXml(result.value);
        if (root?.name !== "ResultSet") {
          return failure("invalid_response");
        }
        const returned = natural(root.attributes["totalResultsReturned"]);
        const container = child(root, "Result");
        const hits = container?.children.filter((node) => node.name === "Hit") ?? [];
        if (returned === null || returned > 1 || returned !== hits.length) {
          return failure("invalid_response");
        }
        total = returned;
        for (const hit of hits) {
          const code = child(hit, "Code")?.value,
            name = child(hit, "Name")?.value;
          const price = natural(child(hit, "Price")?.value);
          if (
            code !== query.query ||
            name === undefined ||
            !text(name, 2000) ||
            price === null ||
            price <= 0 ||
            child(hit, "Price")?.attributes["currency"] !== "JPY"
          ) {
            return failure("invalid_response");
          }
          const link = links(child(hit, "Url")?.value, code, affiliate);
          if (link === null) {
            return failure("invalid_response");
          }
          const available = child(hit, "Availability")?.value;
          const taxable = child(hit, "PriceLabel")?.attributes["taxIncluded"];
          const shipping = natural(child(child(hit, "Shipping"), "Code")?.value);
          // V1 lookup does not document condition. Never carry a search result's condition into a later lookup.
          items.push(
            Object.freeze({
              code,
              name,
              ...link,
              price,
              description: child(hit, "Caption")?.value ?? child(hit, "Description")?.value ?? null,
              imageUrl:
                image(child(child(hit, "ExImage"), "Url")?.value) ??
                image(child(child(hit, "Image"), "Medium")?.value),
              condition: "unknown",
              inStock: available === "instock" ? true : available === "outofstock" ? false : null,
              shippingCode: shipping === 1 || shipping === 2 || shipping === 3 ? shipping : null,
              taxIncluded: taxable === "true" ? true : taxable === "false" ? false : null,
            }),
          );
        }
        if (items.length === 0) {
          return failure("listing_not_found");
        }
      }
      if (new Set(items.map((item) => item.code)).size !== items.length || total < items.length) {
        return failure("invalid_response");
      }
      return {
        tag: "ok",
        value: Object.freeze({
          items: Object.freeze(items),
          total,
          page,
          limit: query.operation === "lookup" ? 1 : limit,
        }),
      };
    },
    async getAffiliateLink(code, signal) {
      if (settings.affiliateId === undefined) {
        return failure("invalid_request");
      }
      const result = await client.request({ operation: "lookup", query: code }, signal);
      if (result.tag === "err") {
        return result;
      }
      const link = result.value.items[0]?.affiliateUrl;
      return typeof link === "string" ? { tag: "ok", value: link } : failure("invalid_response");
    },
  };
  return Object.freeze(client);
}
