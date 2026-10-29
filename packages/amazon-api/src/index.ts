import { failure, natural, record, requestJson, safeUrl, text } from "./transport.js";
import type { ApiResult } from "./transport.js";

type Configuration = Readonly<{
  clientId: string;
  clientSecret: string;
  partnerTag: string;
  credentialVersion?: "3.1" | "3.2" | "3.3";
}>;
type Item = Readonly<{
  asin: string;
  title: string;
  detailPageURL: string;
  imageUrl: string | null;
  features: readonly string[];
  parentASIN: string | null;
  offer: Readonly<{
    amount: number | null;
    condition: string | null;
    availability: string | null;
    violatesMAP: boolean | null;
  }> | null;
}>;
type Page = Readonly<{ items: readonly Item[]; total: number | null; page: number; limit: number }>;
type Query = Readonly<{
  operation: "search" | "lookup";
  query: string;
  page?: number;
  limit?: number;
  includeDetails?: boolean;
}>;
type Client = Readonly<{
  request: (query: Query, signal?: AbortSignal) => Promise<ApiResult<Page>>;
  getItems: (ids: readonly string[], signal?: AbortSignal) => Promise<ApiResult<readonly Item[]>>;
  getVariations: (
    asin: string,
    page?: number,
    limit?: number,
    signal?: AbortSignal,
  ) => Promise<ApiResult<Page>>;
  getAffiliateLink: (asin: string, signal?: AbortSignal) => Promise<ApiResult<string>>;
}>;

function asin(input: unknown): input is string {
  return typeof input === "string" && /^[A-Z0-9]{10}$/u.test(input);
}
function integer(input: number, max: number): boolean {
  return Number.isSafeInteger(input) && input >= 1 && input <= max;
}
function parseItem(raw: unknown, partnerTag: string): Item | null {
  if (
    !record(raw) ||
    !asin(raw["asin"]) ||
    !record(raw["itemInfo"]) ||
    !record(raw["itemInfo"]["title"]) ||
    !text(raw["itemInfo"]["title"]["displayValue"], 2000)
  ) {
    return null;
  }
  const link = safeUrl(raw["detailPageURL"], ["www.amazon.co.jp"]);
  if (
    link === null ||
    !new RegExp("^/(?:dp|gp/product)/" + raw["asin"] + "/?$", "u").test(link.pathname) ||
    link.searchParams.getAll("tag").length !== 1 ||
    link.searchParams.get("tag") !== partnerTag
  ) {
    return null;
  }
  const images =
    record(raw["images"]) && record(raw["images"]["primary"]) ? raw["images"]["primary"] : null;
  const image =
    images === null
      ? null
      : (["large", "medium", "small"].flatMap((size) => {
          const value = images[size];
          const url = record(value)
            ? safeUrl(value["url"], [
                "m.media-amazon.com",
                "images-na.ssl-images-amazon.com",
                "images-fe.ssl-images-amazon.com",
              ])
            : null;
          return url === null ? [] : [url.href];
        })[0] ?? null);
  const info = raw["itemInfo"];
  const featuresRaw = record(info["features"]) ? info["features"]["displayValues"] : undefined;
  if (
    featuresRaw !== undefined &&
    featuresRaw !== null &&
    (!Array.isArray(featuresRaw) ||
      featuresRaw.length > 20 ||
      featuresRaw.some((value: unknown) => !text(value, 4000)))
  ) {
    return null;
  }
  const features: readonly unknown[] = Array.isArray(featuresRaw) ? featuresRaw : [];
  const offers = record(raw["offersV2"]) ? raw["offersV2"]["listings"] : undefined;
  if (offers !== undefined && offers !== null && (!Array.isArray(offers) || offers.length > 10)) {
    return null;
  }
  const entries: readonly unknown[] = Array.isArray(offers) ? offers : [];
  const winners = entries.filter((entry) => record(entry) && entry["isBuyBoxWinner"] === true);
  if (winners.length > 1) {
    return null;
  }
  const featured = winners[0];
  const money =
    record(featured) && record(featured["price"]) && record(featured["price"]["money"])
      ? featured["price"]["money"]
      : null;
  const amount = money !== null && money["currency"] === "JPY" ? natural(money["amount"]) : null;
  const map =
    record(featured) && typeof featured["violatesMAP"] === "boolean"
      ? featured["violatesMAP"]
      : null;
  const condition =
    record(featured) && record(featured["condition"]) ? featured["condition"]["value"] : null;
  const availability =
    record(featured) && record(featured["availability"]) ? featured["availability"]["type"] : null;
  return Object.freeze({
    asin: raw["asin"],
    title: raw["itemInfo"]["title"]["displayValue"],
    detailPageURL: link.href,
    imageUrl: image,
    features: Object.freeze(features.filter((value): value is string => typeof value === "string")),
    parentASIN: asin(raw["parentASIN"]) ? raw["parentASIN"] : null,
    offer: !record(featured)
      ? null
      : Object.freeze({
          amount: map === false && amount !== null && amount > 0 ? amount : null,
          condition: typeof condition === "string" ? condition : null,
          availability: typeof availability === "string" ? availability : null,
          violatesMAP: map,
        }),
  });
}

/** Japan catalog and attribution protocol only. Display and comparison permissions belong to the caller. */
export function createAmazonClient(
  configuration: Configuration,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): Client {
  if (
    !text(configuration.clientId, 512) ||
    /\s/u.test(configuration.clientId) ||
    !text(configuration.clientSecret, 1024) ||
    /\s/u.test(configuration.clientSecret) ||
    !/^[a-zA-Z0-9_-]{1,128}-22$/u.test(configuration.partnerTag) ||
    (configuration.credentialVersion !== undefined &&
      !["3.1", "3.2", "3.3"].includes(configuration.credentialVersion))
  ) {
    throw new Error("Invalid Amazon API credentials");
  }
  const settings = Object.freeze({ ...configuration });
  const tokenHost =
    settings.credentialVersion === "3.1"
      ? "api.amazon.com"
      : settings.credentialVersion === "3.2"
        ? "api.amazon.co.uk"
        : "api.amazon.co.jp";
  let cached: Readonly<{ token: string; expiresAt: number }> | null = null;
  async function token(signal: AbortSignal): Promise<ApiResult<string>> {
    if (cached !== null && cached.expiresAt > clock() + 30000) {
      return { tag: "ok", value: cached.token };
    }
    const result = await requestJson(
      fetcher,
      new URL("https://" + tokenHost + "/auth/o2/token"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          scope: "creatorsapi::default",
        }),
      },
      signal,
    );
    if (result.tag === "err") {
      return result;
    }
    const body = result.value;
    const expires = record(body) ? natural(body["expires_in"]) : null;
    if (
      !record(body) ||
      !text(body["access_token"], 8192) ||
      /\s/u.test(body["access_token"]) ||
      typeof body["token_type"] !== "string" ||
      body["token_type"].toLowerCase() !== "bearer" ||
      expires === null ||
      expires < 1 ||
      expires > 86400
    ) {
      return failure("invalid_response");
    }
    cached = { token: body["access_token"], expiresAt: clock() + expires * 1000 };
    return { tag: "ok", value: cached.token };
  }
  async function catalog(
    operation: "searchItems" | "getItems" | "getVariations",
    parameters: Readonly<Record<string, unknown>>,
    page: number,
    limit: number,
    details: boolean,
    parent?: AbortSignal,
  ): Promise<ApiResult<Page>> {
    const deadline = AbortSignal.timeout(15000);
    const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
    if (signal.aborted) {
      return failure("provider_unavailable");
    }
    const access = await token(signal);
    if (access.tag === "err") {
      return access;
    }
    const result = await requestJson(
      fetcher,
      new URL("https://creatorsapi.amazon/catalog/v1/" + operation),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-marketplace": "www.amazon.co.jp",
          authorization: "Bearer " + access.value,
        },
        body: JSON.stringify({
          ...parameters,
          marketplace: "www.amazon.co.jp",
          partnerTag: settings.partnerTag,
          resources: [
            "itemInfo.title",
            "images.primary.large",
            "parentASIN",
            "offersV2.listings.price",
            "offersV2.listings.condition",
            "offersV2.listings.availability",
            "offersV2.listings.isBuyBoxWinner",
            ...(details ? ["itemInfo.features"] : []),
          ],
        }),
      },
      signal,
    );
    if (result.tag === "err") {
      if (result.error.code === "provider_unauthorized") {
        cached = null;
      }
      return result;
    }
    const body = result.value;
    const container = record(body)
      ? body[
          operation === "searchItems"
            ? "searchResult"
            : operation === "getItems"
              ? "itemsResult"
              : "variationsResult"
        ]
      : null;
    if (
      !record(container) ||
      !Array.isArray(container["items"]) ||
      container["items"].length > limit
    ) {
      return failure("invalid_response");
    }
    const raw: readonly unknown[] = container["items"];
    const items: Item[] = [];
    for (const value of raw) {
      const item = parseItem(value, settings.partnerTag);
      if (item === null || items.some((other) => other.asin === item.asin)) {
        return failure("invalid_response");
      }
      items.push(item);
    }
    const summary = record(container["variationSummary"]) ? container["variationSummary"] : null;
    return {
      tag: "ok",
      value: Object.freeze({
        items: Object.freeze(items),
        total: natural(
          operation === "getVariations"
            ? summary?.["variationCount"]
            : container["totalResultCount"],
        ),
        page,
        limit,
      }),
    };
  }
  async function getItems(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<ApiResult<readonly Item[]>> {
    if (
      ids.length < 1 ||
      ids.length > 10 ||
      ids.some((id) => !asin(id)) ||
      new Set(ids).size !== ids.length
    ) {
      return failure("invalid_request");
    }
    const result = await catalog(
      "getItems",
      { itemIds: ids, itemIdType: "ASIN" },
      1,
      ids.length,
      true,
      signal,
    );
    if (result.tag === "err") {
      return result;
    }
    if (result.value.items.some((item) => !ids.includes(item.asin))) {
      return failure("invalid_response");
    }
    return { tag: "ok", value: result.value.items };
  }
  const client: Client = {
    async request(query, signal) {
      const page = query.page ?? 1,
        limit = query.limit ?? 10;
      if (
        !["search", "lookup"].includes(query.operation) ||
        !text(query.query, 256) ||
        !integer(page, 10) ||
        !integer(limit, 10) ||
        (query.operation === "lookup" && (!asin(query.query) || page !== 1))
      ) {
        return failure("invalid_request");
      }
      const result = await catalog(
        query.operation === "search" ? "searchItems" : "getItems",
        query.operation === "search"
          ? { keywords: query.query, itemCount: limit, itemPage: page }
          : { itemIds: [query.query], itemIdType: "ASIN" },
        page,
        query.operation === "search" ? limit : 1,
        query.includeDetails !== false,
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      if (query.operation === "lookup") {
        if (result.value.items.length === 0) {
          return failure("listing_not_found");
        }
        if (result.value.items[0]?.asin !== query.query) {
          return failure("invalid_response");
        }
      }
      return result;
    },
    getItems,
    async getVariations(id, page = 1, limit = 10, signal) {
      if (!asin(id) || !integer(page, 10) || !integer(limit, 10)) {
        return failure("invalid_request");
      }
      return await catalog(
        "getVariations",
        { asin: id, variationPage: page, variationCount: limit },
        page,
        limit,
        true,
        signal,
      );
    },
    async getAffiliateLink(id, signal) {
      const result = await client.request(
        { operation: "lookup", query: id, includeDetails: false },
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      const item = result.value.items[0];
      return item === undefined
        ? failure("listing_not_found")
        : { tag: "ok", value: item.detailPageURL };
    },
  };
  return Object.freeze(client);
}
