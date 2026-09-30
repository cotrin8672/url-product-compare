import { andThen, err, map, ok, sequence } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { readReference } from "../../comparison/providers.js";
import { httpsUrl, permitted, permissions, record, valueOf } from "../../comparison/values.js";
import type { Instant, Permissions, Schema, SchemaError } from "../../comparison/values.js";
import { parseRakutenUrl } from "./index.js";

type RakutenConfiguration = Readonly<{
  applicationId: string;
  accessKey: string;
  affiliateId: string;
  allowedOrigin: string;
  rights: Permissions;
}>;

export const rakutenConfigurationSchema: Schema<RakutenConfiguration> = Object.freeze({
  parse(input: unknown): Result<RakutenConfiguration, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "rakuten_configuration" });
    }
    const applicationId = input["applicationId"];
    const accessKey = input["accessKey"];
    const affiliateId = input["affiliateId"];
    if (
      typeof applicationId !== "string" ||
      !/^[a-zA-Z0-9-]{8,128}$/.test(applicationId) ||
      typeof accessKey !== "string" ||
      !/^[a-zA-Z0-9_-]{16,512}$/.test(accessKey) ||
      typeof affiliateId !== "string" ||
      !/^[a-fA-F0-9]{8}(?:\.[a-fA-F0-9]{8}){3}$/.test(affiliateId)
    ) {
      return err({ code: "invalid_data", field: "rakuten_credentials" });
    }
    return andThen(httpsUrl(input["allowedOrigin"]), (origin) => {
      const url = new URL(valueOf(origin));
      if (url.pathname !== "/" || url.search !== "") {
        return err({ code: "invalid_data", field: "rakuten_origin" });
      }
      const expiresAt = input["authorizedUntil"];
      return map(
        permissions({
          fetch: { status: "granted", expiresAt },
          display: { status: "granted", expiresAt },
          store: { status: "denied" },
          ai: { status: "denied" },
          affiliate: { status: "granted", expiresAt },
        }),
        (rights) =>
          Object.freeze({
            applicationId,
            accessKey,
            affiliateId,
            allowedOrigin: url.origin,
            rights,
          }),
      );
    });
  },
});

export type RakutenListing = Readonly<{
  mode: "live";
  notice: string;
  provider: "rakuten";
  listingId: string;
  productId: null;
  title: string;
  canonicalUrl: string;
  affiliateUrl: string;
  matchMethod: null;
  observedAt: string;
  expiresAt: string;
  shopName: string;
  price: Readonly<{ minimum: number; maximum: number; currency: "JPY" }>;
  tax: "included" | "excluded";
  shipping: "included" | "excluded";
  availability: "available" | "unavailable";
}>;

type RakutenItem = Readonly<{
  itemCode: string;
  itemName: string;
  itemUrl: string;
  affiliateUrl: string;
  shopCode: string;
  shopName: string;
  minimum: number;
  maximum: number;
  taxFlag: 0 | 1;
  postageFlag: 0 | 1;
  availability: 0 | 1;
}>;

function price(input: unknown): input is number {
  return (
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 999_999_999
  );
}

function affiliateLink(
  input: unknown,
  affiliateId: string,
): Result<Readonly<{ url: string; destination: string }>, SchemaError> {
  return andThen(httpsUrl(input), (link) => {
    const url = new URL(valueOf(link));
    const pc = url.searchParams.getAll("pc");
    const mobile = url.searchParams.getAll("m");
    if (
      url.origin !== "https://hb.afl.rakuten.co.jp" ||
      url.pathname !== `/hgc/${affiliateId}/` ||
      url.hash !== "" ||
      pc.length !== 1 ||
      mobile.length > 1 ||
      [...url.searchParams.keys()].some((key) => !["pc", "m", "scid", "link_type"].includes(key))
    ) {
      return err({ code: "invalid_data", field: "rakuten_affiliate_url" });
    }
    return andThen(httpsUrl(pc[0]), (destination) => {
      const parsed = parseRakutenUrl(destination);
      if (parsed.tag === "err" || parsed.value.tag === "none") {
        return err({ code: "invalid_data", field: "rakuten_affiliate_destination" });
      }
      const canonical = valueOf(readReference(parsed.value.value).canonicalUrl);
      // ponytail: accept mobile destinations only when they are the same modern item URL;
      // legacy mobile URLs need an explicit mapping before they can become purchase links.
      if (mobile.some((entry) => entry !== valueOf(destination))) {
        return err({ code: "invalid_data", field: "rakuten_affiliate_mobile" });
      }
      return ok(Object.freeze({ url: valueOf(link), destination: canonical }));
    });
  });
}

function parseItem(input: unknown, affiliateId: string): Result<RakutenItem, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "rakuten_item" });
  }
  const itemCode = input["itemCode"];
  const itemName = input["itemName"];
  const shopCode = input["shopCode"];
  const shopName = input["shopName"];
  const field = input["itemPriceBaseField"];
  const minimum =
    field === "item_price_min1"
      ? input["itemPriceMin1"]
      : field === "item_price_min2"
        ? input["itemPriceMin2"]
        : field === "item_price_min3"
          ? input["itemPriceMin3"]
          : undefined;
  const maximum =
    field === "item_price_min1"
      ? input["itemPriceMax1"]
      : field === "item_price_min2"
        ? input["itemPriceMax2"]
        : field === "item_price_min3"
          ? input["itemPriceMax3"]
          : undefined;
  const taxFlag = input["taxFlag"];
  const postageFlag = input["postageFlag"];
  const availability = input["availability"];
  if (
    typeof itemCode !== "string" ||
    !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(itemCode) ||
    itemCode.length > 256 ||
    typeof itemName !== "string" ||
    itemName.trim().length === 0 ||
    itemName.length > 2000 ||
    typeof shopCode !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(shopCode) ||
    !itemCode.startsWith(`${shopCode}:`) ||
    typeof shopName !== "string" ||
    shopName.trim().length === 0 ||
    shopName.length > 1000 ||
    !price(minimum) ||
    !price(maximum) ||
    minimum > maximum ||
    (taxFlag !== 0 && taxFlag !== 1) ||
    (postageFlag !== 0 && postageFlag !== 1) ||
    (availability !== 0 && availability !== 1)
  ) {
    return err({ code: "invalid_data", field: "rakuten_item" });
  }
  return andThen(affiliateLink(input["affiliateUrl"], affiliateId), (affiliate) =>
    andThen(httpsUrl(input["itemUrl"]), (itemUrl) => {
      // Rakuten replaces itemUrl with affiliateUrl when affiliateId is supplied.
      const source =
        valueOf(itemUrl) === affiliate.url ? httpsUrl(affiliate.destination) : ok(itemUrl);
      if (source.tag === "err") {
        return source;
      }
      const parsed = parseRakutenUrl(source.value);
      if (parsed.tag === "err" || parsed.value.tag === "none") {
        return err({ code: "invalid_data", field: "rakuten_item_url" });
      }
      if (valueOf(readReference(parsed.value.value).canonicalUrl) !== affiliate.destination) {
        return err({ code: "invalid_data", field: "rakuten_affiliate_destination" });
      }
      return ok(
        Object.freeze({
          itemCode,
          itemName: itemName.trim(),
          itemUrl: valueOf(readReference(parsed.value.value).canonicalUrl),
          affiliateUrl: affiliate.url,
          shopCode,
          shopName: shopName.trim(),
          minimum,
          maximum,
          taxFlag,
          postageFlag,
          availability,
        }),
      );
    }),
  );
}

export type RakutenLookupError =
  | Readonly<{
      code:
        | "invalid_url"
        | "unsupported_url"
        | "invalid_keyword"
        | "source_not_authorized"
        | "listing_not_found"
        | "lookup_incomplete"
        | "ambiguous_listing"
        | "provider_unavailable"
        | "provider_unauthorized"
        | "provider_rate_limited";
    }>
  | SchemaError;

export function createRakutenLookup(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
): (input: string, keyword: string | null) => Promise<Result<RakutenListing, RakutenLookupError>> {
  return async (input, keyword) => {
    try {
      const url = httpsUrl(input);
      if (url.tag === "err") {
        return err({ code: "invalid_url" });
      }
      const parsed = parseRakutenUrl(url.value);
      if (parsed.tag === "err") {
        return parsed;
      }
      if (parsed.value.tag === "none") {
        return err({ code: "unsupported_url" });
      }
      const canonicalUrl = valueOf(readReference(parsed.value.value).canonicalUrl);
      const [shopCode, slug] = new URL(canonicalUrl).pathname.split("/").slice(1);
      const search = keyword?.trim() ?? slug;
      if (
        shopCode === undefined ||
        search === undefined ||
        search.length === 0 ||
        new TextEncoder().encode(search).length > 128
      ) {
        return err({ code: "invalid_keyword" });
      }
      const startedAt = clock();
      if (
        !permitted(configuration.rights.fetch, startedAt) ||
        !permitted(configuration.rights.display, startedAt) ||
        !permitted(configuration.rights.affiliate, startedAt)
      ) {
        return err({ code: "source_not_authorized" });
      }
      // ponytail: search one page (30 items); refine the keyword when the exact URL is absent.
      // Never treat the URL slug as an itemCode or a keyword match as product identity.
      const endpoint = new URL(
        "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701",
      );
      endpoint.search = new URLSearchParams({
        applicationId: configuration.applicationId,
        affiliateId: configuration.affiliateId,
        format: "json",
        formatVersion: "2",
        shopCode,
        keyword: search,
        availability: "0",
        hits: "30",
        page: "1",
        elements:
          "count,itemCode,itemName,itemUrl,affiliateUrl,shopCode,shopName,itemPriceBaseField,itemPriceMin1,itemPriceMax1,itemPriceMin2,itemPriceMax2,itemPriceMin3,itemPriceMax3,taxFlag,postageFlag,availability",
      }).toString();
      const response = await fetcher(endpoint, {
        headers: { accessKey: configuration.accessKey, Origin: configuration.allowedOrigin },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401 || response.status === 403) {
        return err({ code: "provider_unauthorized" });
      }
      if (response.status === 429) {
        return err({ code: "provider_rate_limited" });
      }
      if (response.status === 404) {
        return err({ code: "listing_not_found" });
      }
      if (!response.ok) {
        return err({ code: "provider_unavailable" });
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > 1_048_576) {
        return err({ code: "invalid_data", field: "rakuten_response_size" });
      }
      const rawBody = await response.text();
      if (new TextEncoder().encode(rawBody).length > 1_048_576) {
        return err({ code: "invalid_data", field: "rakuten_response_size" });
      }
      const body: unknown = JSON.parse(rawBody);
      if (
        !record(body) ||
        !Array.isArray(body["Items"]) ||
        body["Items"].length > 30 ||
        typeof body["count"] !== "number" ||
        !Number.isSafeInteger(body["count"]) ||
        body["count"] < 0
      ) {
        return err({ code: "invalid_data", field: "rakuten_response" });
      }
      const items: readonly unknown[] = body["Items"];
      const decoded = sequence(items.map((item) => parseItem(item, configuration.affiliateId)));
      if (decoded.tag === "err") {
        return decoded;
      }
      const matches = decoded.value.filter(
        (item) => item.itemUrl === canonicalUrl && item.shopCode === shopCode,
      );
      if (matches.length > 1) {
        return err({ code: "ambiguous_listing" });
      }
      const [item] = matches;
      if (item === undefined) {
        return err({
          code: body["count"] > items.length ? "lookup_incomplete" : "listing_not_found",
        });
      }
      const now = clock();
      if (
        !permitted(configuration.rights.fetch, now) ||
        !permitted(configuration.rights.display, now) ||
        !permitted(configuration.rights.affiliate, now) ||
        configuration.rights.display.status !== "granted"
      ) {
        return err({ code: "source_not_authorized" });
      }
      return ok(
        Object.freeze({
          mode: "live",
          notice: "掲載URLを確認しました。製品・バリエーション・配送先別の総額は未確認です。",
          provider: "rakuten",
          listingId: item.itemCode,
          productId: null,
          title: item.itemName,
          canonicalUrl,
          affiliateUrl: item.affiliateUrl,
          matchMethod: null,
          observedAt: valueOf(now),
          expiresAt: new Date(
            Math.min(
              Date.parse(valueOf(now)) + 900_000,
              Date.parse(valueOf(configuration.rights.display.expiresAt)),
            ),
          ).toISOString(),
          shopName: item.shopName,
          price: Object.freeze({ minimum: item.minimum, maximum: item.maximum, currency: "JPY" }),
          tax: item.taxFlag === 0 ? "included" : "excluded",
          shipping: item.postageFlag === 0 ? "included" : "excluded",
          availability: item.availability === 1 ? "available" : "unavailable",
        }),
      );
    } catch {
      return err({ code: "provider_unavailable" });
    }
  };
}
