import { andThen, err, ok, sequence } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { readConsumerListingCondition } from "../../comparison/consumer-catalog.js";
import type { ConsumerListingCondition } from "../../comparison/consumer-catalog.js";
import type { ConsumerCategoryAttribute } from "../../comparison/consumer-provider.js";
import { readConsumerInformation } from "../../comparison/consumer.js";
import type { ConsumerCategory, ConsumerInformation } from "../../comparison/consumer.js";
import { readMonitorSpecifications } from "../../comparison/monitor.js";
import type { MonitorSpecifications } from "../../comparison/monitor.js";
import {
  applySpecificationFacts,
  emptySpecifications,
  numericSpecificationFields,
  readNumericSpecification,
  specificationDescriptionFacts,
  titleModelHint,
} from "../../comparison/product-information.js";
import type {
  ProductSpecifications,
  SpecificationExtractionInput,
  SpecificationExtractor,
  SpecificationFact,
} from "../../comparison/product-information.js";
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
      const storageExpiresAt = input["resultStorageAuthorizedUntil"];
      return andThen(
        permissions({
          fetch: { status: "granted", expiresAt },
          display: { status: "granted", expiresAt },
          store:
            storageExpiresAt === undefined
              ? { status: "denied" }
              : { status: "granted", expiresAt: storageExpiresAt },
          ai: { status: "granted", expiresAt },
          affiliate: { status: "granted", expiresAt },
        }),
        (rights) => {
          if (
            rights.store.status === "granted" &&
            rights.display.status === "granted" &&
            valueOf(rights.store.expiresAt) > valueOf(rights.display.expiresAt)
          ) {
            return err({ code: "invalid_data", field: "rakuten_result_storage_expiry" });
          }
          return ok(
            Object.freeze({
              applicationId,
              accessKey,
              affiliateId,
              allowedOrigin: url.origin,
              rights,
            }),
          );
        },
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
  imageUrl?: string | null;
  specifications?: ProductSpecifications;
  specificationFacts?: readonly SpecificationFact[];
  identityVerified?: boolean;
  rakutenProductId?: string | null;
  genreId?: string | null;
  monitorSpecifications?: MonitorSpecifications;
}>;

// Keep source descriptions inside the adapter; JSON serialization never sends them to clients.
const descriptions = new WeakMap<RakutenListing, string>();
const specificationEvidence = new WeakMap<
  RakutenListing,
  Readonly<{ listing: string; product: string }>
>();

export function readRakutenConsumerInformation(
  listing: RakutenListing,
  category: ConsumerCategory,
): ConsumerInformation {
  return readConsumerInformation(
    category,
    listing.listingId,
    listing.canonicalUrl,
    specificationEvidence.get(listing)?.listing ?? descriptions.get(listing) ?? "",
    specificationEvidence.get(listing)?.product ?? "",
    { listing: "rakuten_item_api", product: "rakuten_product_api" },
  );
}

export function readRakutenListingCondition(listing: RakutenListing): ConsumerListingCondition {
  const description =
    specificationEvidence.get(listing)?.listing ?? descriptions.get(listing) ?? "";
  return readConsumerListingCondition(listing.title, description);
}
const requests = new WeakMap<RakutenConfiguration, WeakMap<typeof fetch, typeof fetch>>();

function pacedFetcher(configuration: RakutenConfiguration, fetcher: typeof fetch): typeof fetch {
  const existing = requests.get(configuration)?.get(fetcher);
  if (existing !== undefined) {
    return existing;
  }
  let nextRequestAt = 0;
  let previous: Promise<void> = Promise.resolve();
  const paced: typeof fetch = async (input, init) => {
    const result = previous.then(async () => {
      const signal = init?.signal ?? null;
      if (signal?.aborted === true) {
        throw new Error("request_expired");
      }
      const wait = nextRequestAt - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new Error("request_expired"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, wait);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) {
            onAbort();
          }
        });
      }
      nextRequestAt = Date.now() + 1100;
      signal?.throwIfAborted();
      return await fetcher(input, init);
    });
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };
  const scoped = requests.get(configuration) ?? new WeakMap<typeof fetch, typeof fetch>();
  scoped.set(fetcher, paced);
  requests.set(configuration, scoped);
  return paced;
}

function requestSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

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
  description: string;
  imageUrl: string | null;
  genreId: string | null;
}>;

function image(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const parsed = httpsUrl(input);
  if (parsed.tag === "err") {
    return null;
  }
  const url = new URL(valueOf(parsed.value));
  return url.hostname.endsWith(".rakuten.co.jp") || url.hostname.endsWith(".rakuten.ne.jp")
    ? valueOf(parsed.value)
    : null;
}

function itemDescription(input: string): string {
  return input
    .replace(
      /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi,
      (_match: string, label: string, value: string) =>
        `${label.replace(/<[^>]*>/g, " ")}: ${value.replace(/<[^>]*>/g, " ")}\n`,
    )
    .replace(/<(?:br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .slice(0, 12_000);
}

function price(input: unknown): input is number {
  return (
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 999_999_999
  );
}

function affiliateLink(
  input: unknown,
  affiliateId: string,
  itemCode: string,
): Result<Readonly<{ url: string; destination: string }>, SchemaError> {
  return andThen(httpsUrl(input), (link) => {
    const url = new URL(valueOf(link));
    const pc = url.searchParams.getAll("pc");
    const mobile = url.searchParams.getAll("m");
    // The live API can return a legacy shop alias. We never publish that alias:
    // rebuild the link with our configured affiliate ID and verified PC destination.
    const legacyAlias = /^\/hgc\/(g00[a-z0-9]{5})\.[a-z0-9]{8}\.\1\.[a-z0-9]{8}\/$/.test(
      url.pathname,
    );
    if (
      url.origin !== "https://hb.afl.rakuten.co.jp" ||
      (url.pathname !== `/hgc/${affiliateId}/` && !legacyAlias) ||
      url.hash !== "" ||
      pc.length !== 1 ||
      mobile.length > 1 ||
      [...url.searchParams.keys()].some(
        (key) => !["pc", "m", "scid", "link_type", "rafcid"].includes(key),
      )
    ) {
      return err({ code: "invalid_data", field: "rakuten_affiliate_url" });
    }
    return andThen(httpsUrl(pc[0]), (destination) => {
      const parsed = parseRakutenUrl(destination);
      if (parsed.tag === "err" || parsed.value.tag === "none") {
        return err({ code: "invalid_data", field: "rakuten_affiliate_destination" });
      }
      const canonical = valueOf(readReference(parsed.value.value).canonicalUrl);
      const [shop, item] = itemCode.split(":");
      const validMobile = (entry: string): boolean => {
        if (entry === valueOf(destination)) {
          return true;
        }
        if (
          !legacyAlias ||
          entry.length > 8192 ||
          /[\p{Cc}\s]/u.test(entry) ||
          !URL.canParse(entry)
        ) {
          return false;
        }
        // Legacy HTTP mobile URLs are checked as identifiers only; the published link uses HTTPS.
        const mobileUrl = new URL(entry);
        return (
          ["http:", "https:"].includes(mobileUrl.protocol) &&
          mobileUrl.hostname === "m.rakuten.co.jp" &&
          mobileUrl.port === "" &&
          mobileUrl.username === "" &&
          mobileUrl.password === "" &&
          mobileUrl.pathname === `/${shop ?? ""}/i/${item ?? ""}/` &&
          mobileUrl.hash === "" &&
          [...mobileUrl.searchParams.keys()].every((key) =>
            ["rafcid", "scid", "s-id"].includes(key),
          )
        );
      };
      if (mobile.some((entry) => !validMobile(entry))) {
        return err({ code: "invalid_data", field: "rakuten_affiliate_mobile" });
      }
      const rebuilt = new URL(`https://hb.afl.rakuten.co.jp/hgc/${affiliateId}/`);
      rebuilt.search = new URLSearchParams({ pc: canonical, m: canonical }).toString();
      return ok(
        Object.freeze({
          url: legacyAlias || url.searchParams.has("rafcid") ? rebuilt.toString() : valueOf(link),
          destination: canonical,
        }),
      );
    });
  });
}

function rakutenGenreId(input: unknown): string | null {
  if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 999999) {
    return String(input);
  }
  return typeof input === "string" && /^\d{1,6}$/.test(input) ? input : null;
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
  const itemCaption = input["itemCaption"];
  const mediumImages = input["mediumImageUrls"];
  const rawGenreId = input["genreId"] ?? null;
  const genreId = rakutenGenreId(rawGenreId);
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
    (availability !== 0 && availability !== 1) ||
    (itemCaption !== undefined && itemCaption !== null && typeof itemCaption !== "string") ||
    (typeof itemCaption === "string" && itemCaption.length > 65_536) ||
    (mediumImages !== undefined && !Array.isArray(mediumImages)) ||
    (Array.isArray(mediumImages) && mediumImages.length > 3) ||
    (rawGenreId !== null && genreId === null)
  ) {
    return err({ code: "invalid_data", field: "rakuten_item" });
  }
  const checkedAffiliate = affiliateLink(input["affiliateUrl"], affiliateId, itemCode);
  if (checkedAffiliate.tag === "err") {
    return err({
      code: "invalid_data",
      field: checkedAffiliate.error.field.startsWith("rakuten_affiliate")
        ? checkedAffiliate.error.field
        : "rakuten_affiliate_url",
    });
  }
  return andThen(checkedAffiliate, (affiliate) =>
    andThen(httpsUrl(input["itemUrl"]), (itemUrl) => {
      // Rakuten replaces itemUrl with affiliateUrl when affiliateId is supplied.
      const source =
        valueOf(itemUrl) === affiliate.url || valueOf(itemUrl) === input["affiliateUrl"]
          ? httpsUrl(affiliate.destination)
          : ok(itemUrl);
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
      if (new URL(affiliate.destination).pathname.split("/")[1] !== shopCode) {
        return err({ code: "invalid_data", field: "rakuten_item_shop" });
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
          description: typeof itemCaption === "string" ? itemDescription(itemCaption) : "",
          genreId,
          imageUrl: Array.isArray(mediumImages)
            ? (mediumImages
                .map((entry: unknown) => image(record(entry) ? entry["imageUrl"] : entry))
                .find((entry: string | null) => entry !== null) ?? null)
            : null,
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

export function createRakutenSearch(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
): (
  keyword: string,
  shopCode: string | null,
  genreId?: string,
  options?: Readonly<{
    page?: number;
    hits?: number;
    excludeKeyword?: string;
    signal?: AbortSignal;
    invalidAffiliate?: "skip";
  }>,
) => Promise<
  Result<Readonly<{ count: number; listings: readonly RakutenListing[] }>, RakutenLookupError>
> {
  const request = pacedFetcher(configuration, fetcher);
  return async (search, shopCode, genreId, options = {}) => {
    try {
      if (options.signal?.aborted === true) {
        return err({ code: "provider_unavailable" });
      }
      if (
        (shopCode !== null && !/^[a-zA-Z0-9_-]+$/.test(shopCode)) ||
        (genreId !== undefined && !/^\d{1,6}$/.test(genreId)) ||
        !Number.isSafeInteger(options.page ?? 1) ||
        (options.page ?? 1) < 1 ||
        (options.page ?? 1) > 100 ||
        !Number.isSafeInteger(options.hits ?? 10) ||
        (options.hits ?? 10) < 1 ||
        (options.hits ?? 10) > 30 ||
        (search.length === 0 && genreId === undefined && shopCode === null) ||
        new TextEncoder().encode(search).length > 128 ||
        (options.excludeKeyword !== undefined &&
          (options.excludeKeyword.length === 0 ||
            new TextEncoder().encode(options.excludeKeyword).length > 128))
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
      // Never treat the URL slug as an itemCode or a keyword match as product identity.
      const endpoint = new URL(
        "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701",
      );
      endpoint.search = new URLSearchParams({
        applicationId: configuration.applicationId,
        affiliateId: configuration.affiliateId,
        format: "json",
        formatVersion: "2",
        ...(shopCode === null ? {} : { shopCode }),
        ...(genreId === undefined ? {} : { genreId }),
        ...(search.length === 0 ? {} : { keyword: search }),
        availability: "0",
        ...(options.excludeKeyword === undefined ? {} : { NGKeyword: options.excludeKeyword }),
        hits: String(options.hits ?? (shopCode === null ? 10 : 30)),
        page: String(options.page ?? 1),
        elements:
          "count,itemCode,itemName,itemCaption,mediumImageUrls,itemUrl,affiliateUrl,shopCode,shopName,itemPriceBaseField,itemPriceMin1,itemPriceMax1,itemPriceMin2,itemPriceMax2,itemPriceMin3,itemPriceMax3,taxFlag,postageFlag,availability,genreId",
      }).toString();
      const response = await request(endpoint, {
        headers: { accessKey: configuration.accessKey, Origin: configuration.allowedOrigin },
        redirect: "error",
        signal: requestSignal(options.signal, 8000),
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
      const itemsRaw =
        record(body) && body["count"] === 0 && body["Items"] === undefined
          ? []
          : record(body)
            ? body["Items"]
            : undefined;
      if (
        !record(body) ||
        !Array.isArray(itemsRaw) ||
        itemsRaw.length > (options.hits ?? (shopCode === null ? 10 : 30)) ||
        typeof body["count"] !== "number" ||
        !Number.isSafeInteger(body["count"]) ||
        body["count"] < 0
      ) {
        return err({ code: "invalid_data", field: "rakuten_response" });
      }
      const items: readonly unknown[] = itemsRaw;
      const decoded = sequence(
        items
          .map((item) => parseItem(item, configuration.affiliateId))
          .filter(
            (result) =>
              !(
                options.invalidAffiliate === "skip" &&
                result.tag === "err" &&
                result.error.field.startsWith("rakuten_affiliate")
              ),
          ),
      );
      if (decoded.tag === "err") {
        return decoded;
      }
      options.signal?.throwIfAborted();
      const now = clock();
      if (
        !permitted(configuration.rights.fetch, now) ||
        !permitted(configuration.rights.display, now) ||
        !permitted(configuration.rights.affiliate, now) ||
        configuration.rights.display.status !== "granted"
      ) {
        return err({ code: "source_not_authorized" });
      }
      const displayExpiry = configuration.rights.display.expiresAt;
      const listings = decoded.value.map((item): RakutenListing => {
        const listing: RakutenListing = Object.freeze({
          mode: "live",
          notice:
            "楽天APIから取得した掲載情報です。製品・バリエーション・配送先別の総額は未確認です。",
          provider: "rakuten",
          listingId: item.itemCode,
          productId: null,
          title: item.itemName,
          canonicalUrl: item.itemUrl,
          affiliateUrl: item.affiliateUrl,
          matchMethod: null,
          observedAt: valueOf(now),
          expiresAt: new Date(
            Math.min(Date.parse(valueOf(now)) + 900_000, Date.parse(valueOf(displayExpiry))),
          ).toISOString(),
          shopName: item.shopName,
          price: Object.freeze({ minimum: item.minimum, maximum: item.maximum, currency: "JPY" }),
          tax: item.taxFlag === 0 ? "included" : "excluded",
          shipping: item.postageFlag === 0 ? "included" : "excluded",
          availability: item.availability === 1 ? "available" : "unavailable",
          imageUrl: item.imageUrl,
          genreId: item.genreId,
        });
        descriptions.set(listing, item.description);
        return listing;
      });
      return ok(Object.freeze({ count: body["count"], listings: Object.freeze(listings) }));
    } catch {
      return err({ code: "provider_unavailable" });
    }
  };
}

export function createRakutenLookup(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
  maxPages = 1,
): (
  input: string,
  keyword: string | null,
  fallbackKeyword?: string,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<Result<RakutenListing, RakutenLookupError>> {
  const search = createRakutenSearch(configuration, clock, fetcher);
  return async (input, keyword, fallbackKeyword, options) => {
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
    if (shopCode === undefined || slug === undefined) {
      return err({ code: "unsupported_url" });
    }
    let query = keyword?.trim() ?? slug;
    const backupQuery = fallbackKeyword ?? "";
    let page = 1;
    for (let attempt = 1; attempt <= Math.min(3, maxPages); attempt += 1) {
      if (options?.signal?.aborted === true) {
        return err({ code: "provider_unavailable" });
      }
      const result = await search(query, shopCode, undefined, {
        page,
        hits: 30,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.tag === "err") {
        return result;
      }
      const matches = result.value.listings.filter(
        (item) => item.canonicalUrl === canonicalUrl && item.listingId.startsWith(`${shopCode}:`),
      );
      if (matches.length > 1) {
        return err({ code: "ambiguous_listing" });
      }
      const [item] = matches;
      if (item !== undefined) {
        return ok(item);
      }
      if (maxPages === 1) {
        return err({
          code:
            result.value.count > result.value.listings.length
              ? "lookup_incomplete"
              : "listing_not_found",
        });
      }
      if (result.value.count <= page * 30 || result.value.listings.length === 0) {
        if (keyword === null && query !== backupQuery) {
          query = backupQuery;
          page = 1;
        } else {
          return err({ code: "listing_not_found" });
        }
      } else {
        page += 1;
      }
    }
    return err({ code: "lookup_incomplete" });
  };
}

type RakutenGenre = Readonly<{
  id: string;
  label: string | null;
  lineage: readonly string[];
  attributes: readonly ConsumerCategoryAttribute[] | null;
}>;

function genreAttributes(input: unknown): readonly ConsumerCategoryAttribute[] | null {
  if (!Array.isArray(input) || input.length > 128) {
    return null;
  }
  const entries: readonly unknown[] = input;
  const attributes: ConsumerCategoryAttribute[] = [];
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!record(entry)) {
      return null;
    }
    const id = entry["attributeId"] ?? entry["id"];
    const label = entry["nameJa"];
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      ids.has(id) ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80 ||
      /[\p{Cc}]/u.test(label)
    ) {
      return null;
    }
    ids.add(id);
    attributes.push(Object.freeze({ id, label: label.trim() }));
  }
  return Object.freeze(attributes);
}

/** Share the genre's lineage and attribute dictionary with a bounded, expiring cache. */
export function createRakutenGenreResolver(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
): (
  genreId: string | null | undefined,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<RakutenGenre | null> {
  const request = pacedFetcher(configuration, fetcher);
  const cache = new Map<string, Readonly<{ genre: RakutenGenre; expires: number }>>();
  return async (genreId, options) => {
    if (
      genreId === null ||
      genreId === undefined ||
      !/^\d{1,6}$/.test(genreId) ||
      !permitted(configuration.rights.fetch, clock()) ||
      !permitted(configuration.rights.display, clock())
    ) {
      return null;
    }
    const cached = cache.get(genreId);
    if (cached !== undefined && cached.expires > Date.parse(valueOf(clock()))) {
      return cached.genre;
    }
    if (options?.signal?.aborted === true) {
      return null;
    }
    try {
      const endpoint = new URL(
        "https://openapi.rakuten.co.jp/ichibagt/api/IchibaGenre/Search/20260701",
      );
      endpoint.search = new URLSearchParams({
        applicationId: configuration.applicationId,
        genreId,
        format: "json",
        formatVersion: "2",
      }).toString();
      const response = await request(endpoint, {
        headers: { accessKey: configuration.accessKey, Origin: configuration.allowedOrigin },
        redirect: "error",
        signal: requestSignal(options?.signal, 5000),
      });
      if (!response.ok) {
        return null;
      }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).length > 262144) {
        return null;
      }
      const body: unknown = JSON.parse(raw);
      if (
        !record(body) ||
        !record(body["genre"]) ||
        rakutenGenreId(body["genre"]["genreId"]) !== genreId ||
        !Array.isArray(body["ancestors"]) ||
        body["ancestors"].length > 10
      ) {
        return null;
      }
      const ancestors: readonly unknown[] = body["ancestors"];
      const lineage = Object.freeze(
        [
          genreId,
          ...ancestors
            .map((entry) => (record(entry) ? rakutenGenreId(entry["genreId"]) : null))
            .filter((entry): entry is string => entry !== null),
        ].filter((entry, index, values) => values.indexOf(entry) === index),
      );
      options?.signal?.throwIfAborted();
      if (!permitted(configuration.rights.display, clock())) {
        return null;
      }
      const name = body["genre"]["nameJa"];
      const genre: RakutenGenre = Object.freeze({
        id: genreId,
        label:
          typeof name === "string" &&
          name.trim().length > 0 &&
          name.length <= 80 &&
          !/[\p{Cc}]/u.test(name)
            ? name.trim()
            : null,
        lineage,
        attributes: genreAttributes(body["attributes"] ?? []),
      });
      cache.delete(genreId);
      cache.set(genreId, { genre, expires: Date.parse(valueOf(clock())) + 86_400_000 });
      if (cache.size > 128) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      return genre;
    } catch {
      options?.signal?.throwIfAborted();
      return null;
    }
  };
}

type ProductMetadata = Readonly<{
  id: string;
  model: string | null;
  brand: string | null;
  gtin: string | null;
  color: string | null;
  description: string;
  facts: readonly SpecificationFact[];
  specificationText: string;
}>;

function validGtin(input: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(input)) {
    return false;
  }
  const digits = Array.from({ length: input.length }, (_, index) => Number(input.charAt(index)));
  const total = digits
    .slice(0, -1)
    .reverse()
    .reduce((sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === digits.at(-1);
}

function modelToken(input: string): string | null {
  const normalized = input.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(normalized) && /\d/.test(normalized)
    ? normalized
    : null;
}

function productColor(input: string): string | null {
  const values = new Set<string>();
  for (const match of input.matchAll(/ブラック|ホワイト|黒色|白色|\bblack\b|\bwhite\b/gi)) {
    values.add(/^(?:ブラック|黒色|black)$/i.test(match[0]) ? "ブラック" : "ホワイト");
  }
  return values.size === 1 ? ([...values][0] ?? null) : null;
}

function identityHints(
  listing: RakutenListing,
  description: string,
): Readonly<{ model: string | null; gtin: string | null; color: string | null }> {
  const model = /(?:メーカー型番|型番|品番|model)\s*[:：]?\s*([a-zA-Z0-9._-]{2,64})/i.exec(
    description,
  )?.[1];
  const jan = /(?:JAN(?:コード)?|GTIN)\s*[:：]?\s*(\d{8,14})(?!\d)/i.exec(description)?.[1];
  const color = /(?:カラー|色)\s*[:：]\s*([^\n。;；]{1,32})/u.exec(description)?.[1]?.trim();
  return Object.freeze({
    model: model === undefined ? titleModelHint(listing.title) : modelToken(model),
    gtin: jan !== undefined && validGtin(jan) ? jan : null,
    color: color === undefined ? productColor(listing.title) : (productColor(color) ?? color),
  });
}

function productMetadata(
  input: unknown,
  hints: ReturnType<typeof identityHints>,
  sourceUrl: string,
): ProductMetadata | null {
  if (!record(input)) {
    return null;
  }
  const id = input["productId"];
  const model = typeof input["productNo"] === "string" ? modelToken(input["productNo"]) : null;
  const gtin =
    typeof input["productCode"] === "string" && validGtin(input["productCode"])
      ? input["productCode"]
      : null;
  const name = input["productName"];
  const caption = input["productCaption"];
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{32}$/i.test(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 2000 ||
    (caption !== undefined &&
      caption !== null &&
      (typeof caption !== "string" || caption.length > 65_536)) ||
    (hints.gtin !== null && hints.gtin !== gtin) ||
    (hints.model !== null && hints.model !== model) ||
    (hints.gtin === null && hints.model === null)
  ) {
    return null;
  }
  const brandValue = input["brandName"] ?? input["makerName"];
  const brand =
    typeof brandValue === "string" && brandValue.trim().length > 0 && brandValue.length <= 256
      ? brandValue.trim()
      : null;
  const details = input["ProductDetails"];
  if (
    details !== null &&
    details !== undefined &&
    (!Array.isArray(details) || details.length > 100)
  ) {
    return null;
  }
  const entries: readonly unknown[] = Array.isArray(details) ? details : [];
  const facts: SpecificationFact[] = [];
  const specificationLines: string[] = [];
  let color: string | null = productColor(name);
  for (const detail of entries) {
    if (
      !record(detail) ||
      typeof detail["name"] !== "string" ||
      typeof detail["value"] !== "string" ||
      detail["name"].length > 100 ||
      detail["value"].length > 300
    ) {
      return null;
    }
    const label = detail["name"].normalize("NFKC").trim();
    const quote = `${label}: ${detail["value"]}`;
    specificationLines.push(quote);
    if (["カラー", "色", "代表カラー"].includes(label)) {
      color = productColor(detail["value"]) ?? detail["value"].trim();
    }
    for (const field of numericSpecificationFields) {
      const value = readNumericSpecification(field, quote);
      if (value !== null) {
        facts.push(Object.freeze({ field, value, source: "rakuten-api", sourceUrl, quote }));
      }
    }
  }
  if (hints.color !== null && color !== null && hints.color !== color) {
    return null;
  }
  const uniqueFacts = facts.filter(
    (fact) => !facts.some((other) => other.field === fact.field && other.value !== fact.value),
  );
  for (const [field, value] of [
    ["model", model],
    ["brand", brand],
    ["gtin", gtin],
    ["color", color],
  ] satisfies ReadonlyArray<readonly [keyof ProductSpecifications, string | null]>) {
    if (value !== null) {
      uniqueFacts.push(
        Object.freeze({ field, value, source: "rakuten-api", sourceUrl, quote: value }),
      );
    }
  }
  return Object.freeze({
    id,
    model,
    brand,
    gtin,
    color,
    description: typeof caption === "string" ? itemDescription(caption) : "",
    facts: Object.freeze(uniqueFacts),
    specificationText: specificationLines.join("\n"),
  });
}

function reuseSpecifications(
  listings: readonly RakutenListing[],
  stored: readonly RakutenListing[],
  now: Instant,
): readonly RakutenListing[] {
  return Object.freeze(
    listings.map((listing, index) => {
      const enriched = stored[index];
      if (enriched === undefined || Date.parse(enriched.expiresAt) <= Date.parse(valueOf(now))) {
        return listing;
      }
      const output: RakutenListing = Object.freeze({
        ...listing,
        imageUrl: listing.imageUrl ?? enriched.imageUrl ?? null,
        expiresAt: listing.expiresAt < enriched.expiresAt ? listing.expiresAt : enriched.expiresAt,
        specifications: enriched.specifications ?? emptySpecifications,
        specificationFacts: enriched.specificationFacts ?? [],
        identityVerified: enriched.identityVerified ?? false,
        rakutenProductId: enriched.rakutenProductId ?? null,
        ...(enriched.monitorSpecifications === undefined
          ? {}
          : { monitorSpecifications: enriched.monitorSpecifications }),
      });
      descriptions.set(output, descriptions.get(listing) ?? "");
      specificationEvidence.set(
        output,
        Object.freeze({
          listing: descriptions.get(listing) ?? "",
          product: specificationEvidence.get(enriched)?.product ?? "",
        }),
      );
      return output;
    }),
  );
}

function specificationSnippet(description: string, fields: readonly string[]): string {
  const pattern = fields
    .map((field) => {
      switch (field) {
        case "maxPowerW":
          return "出力|power|output";
        case "usbCPorts":
          return "USB[- ]?(?:Type[- ]?)?C";
        case "usbAPorts":
          return "USB[- ]?(?:Type[- ]?)?A";
        case "weightG":
          return "重量|質量|重さ|weight";
        case "warrantyMonths":
          return "保証|warranty";
        default:
          return "(?!)";
      }
    })
    .join("|");
  const snippets: string[] = [];
  let end = 0;
  let length = 0;
  for (const match of description.matchAll(new RegExp(pattern, "gi"))) {
    const start = Math.max(end, match.index - 40);
    const finish = Math.min(description.length, match.index + match[0].length + 160);
    if (finish <= end) {
      continue;
    }
    const snippet = description.slice(start, finish);
    if (length + snippet.length > 1800) {
      break;
    }
    snippets.push(snippet);
    length += snippet.length + 1;
    end = finish;
  }
  return snippets.join("\n").slice(0, 1800);
}

/** Free API fields first, labelled descriptions next, one paid extraction batch only if still useful. */
export function createRakutenEnricher(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  extractor?: SpecificationExtractor,
  fetcher: typeof fetch = fetch,
): (
  listings: readonly RakutenListing[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<readonly RakutenListing[]> {
  const request = pacedFetcher(configuration, fetcher);
  const cache = new Map<string, Readonly<{ until: number; listings: readonly RakutenListing[] }>>();
  const inflight = new Map<string, Promise<readonly RakutenListing[]>>();
  const authorized = (now: Instant): boolean =>
    permitted(configuration.rights.fetch, now) && permitted(configuration.rights.display, now);

  const enrich = async (
    listings: readonly RakutenListing[],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ listings: readonly RakutenListing[]; cacheable: boolean }>> => {
    const deadline = Date.now() + 10_000;
    const enriched: RakutenListing[] = [];
    let cacheable = true;
    for (const listing of listings) {
      options?.signal?.throwIfAborted();
      let description = descriptions.get(listing) ?? "";
      const hints = identityHints(listing, description);
      let metadata: ProductMetadata | null = null;
      if (
        (hints.gtin !== null || hints.model !== null) &&
        authorized(clock()) &&
        Date.now() < deadline &&
        Date.parse(listing.expiresAt) > Date.parse(valueOf(clock()))
      ) {
        try {
          const endpoint = new URL(
            "https://openapi.rakuten.co.jp/ichibaproduct/api/Product/Search/20250801",
          );
          endpoint.search = new URLSearchParams({
            applicationId: configuration.applicationId,
            format: "json",
            formatVersion: "2",
            hits: "10",
            ...(hints.gtin === null ? { keyword: hints.model ?? "" } : { productCode: hints.gtin }),
          }).toString();
          const response = await request(endpoint, {
            headers: { accessKey: configuration.accessKey, Origin: configuration.allowedOrigin },
            redirect: "error",
            signal: requestSignal(
              options?.signal,
              Math.max(1, Math.min(8000, deadline - Date.now())),
            ),
          });
          if (response.ok) {
            const contentLength = response.headers.get("content-length");
            const raw =
              contentLength !== null && Number(contentLength) > 1_048_576
                ? ""
                : await response.text();
            if (new TextEncoder().encode(raw).length <= 1_048_576) {
              const body: unknown = JSON.parse(raw);
              if (
                record(body) &&
                Array.isArray(body["Products"]) &&
                body["Products"].length <= 10
              ) {
                const products: readonly unknown[] = body["Products"];
                const matches = products
                  .map((product) => productMetadata(product, hints, listing.canonicalUrl))
                  .filter((product) => product !== null);
                metadata = matches.length === 1 ? (matches[0] ?? null) : null;
              } else {
                cacheable = false;
              }
            } else {
              cacheable = false;
            }
          } else {
            cacheable = false;
          }
        } catch {
          options?.signal?.throwIfAborted();
          // Optional specifications must not discard a valid price/listing on metadata failure.
          metadata = null;
          cacheable = false;
        }
      } else if (hints.gtin !== null || hints.model !== null) {
        cacheable = false;
      }
      options?.signal?.throwIfAborted();
      if (!authorized(clock()) || Date.parse(listing.expiresAt) <= Date.parse(valueOf(clock()))) {
        enriched.push(listing);
        cacheable = false;
        continue;
      }
      if (metadata !== null && metadata.description.length > 0) {
        description = `${description}\n${metadata.description}`.slice(0, 12_000);
      }
      const apiFacts = metadata?.facts ?? [];
      const descriptionFacts = specificationDescriptionFacts(
        description,
        listing.canonicalUrl,
      ).filter((fact) => !apiFacts.some((existing) => existing.field === fact.field));
      const specifications = applySpecificationFacts(
        Object.freeze({
          ...emptySpecifications,
          model: metadata?.model ?? null,
          brand: metadata?.brand ?? null,
          gtin: metadata?.gtin ?? null,
          color: metadata?.color ?? null,
        }),
        [...apiFacts, ...descriptionFacts],
      );
      const output: RakutenListing = Object.freeze({
        ...listing,
        imageUrl: listing.imageUrl ?? null,
        specifications,
        specificationFacts: Object.freeze([...apiFacts, ...descriptionFacts]),
        identityVerified:
          metadata?.model !== null && metadata?.model !== undefined && metadata.gtin !== null,
        rakutenProductId: metadata?.id ?? null,
        ...(listing.genreId === "110105"
          ? {
              monitorSpecifications: readMonitorSpecifications(
                `${metadata?.specificationText ?? ""}\n${description}`,
              ),
            }
          : {}),
      });
      descriptions.set(output, description);
      specificationEvidence.set(
        output,
        Object.freeze({
          listing: descriptions.get(listing) ?? "",
          product: `${metadata?.specificationText ?? ""}\n${metadata?.description ?? ""}`,
        }),
      );
      enriched.push(output);
    }
    const aiAllowed = (): boolean =>
      authorized(clock()) && permitted(configuration.rights.ai, clock());
    const inputs: readonly SpecificationExtractionInput[] = enriched.flatMap((listing) => {
      const original = descriptions.get(listing) ?? "";
      const missingFields = numericSpecificationFields.filter(
        (field) => (listing.specifications ?? emptySpecifications)[field] === null,
      );
      const description = specificationSnippet(original, missingFields);
      // No charge for empty descriptions or text without any missing-field labels to extract.
      return description.trim().length === 0 || missingFields.length === 0
        ? []
        : [
            Object.freeze({
              listingId: listing.listingId,
              description,
              evidenceText: original,
              missingFields,
            }),
          ];
    });
    if (extractor === undefined || inputs.length === 0 || !aiAllowed()) {
      return Object.freeze({ listings: Object.freeze(enriched), cacheable });
    }
    try {
      options?.signal?.throwIfAborted();
      const result = await extractor(inputs);
      options?.signal?.throwIfAborted();
      if (result.tag === "err" || !aiAllowed()) {
        return Object.freeze({ listings: Object.freeze(enriched), cacheable: false });
      }
      return Object.freeze({
        cacheable,
        listings: Object.freeze(
          enriched.map((listing) => {
            const facts = result.value
              .find((entry) => entry.listingId === listing.listingId)
              ?.facts.map((fact) => Object.freeze({ ...fact, sourceUrl: listing.canonicalUrl }));
            if (Date.parse(listing.expiresAt) <= Date.parse(valueOf(clock()))) {
              return (
                listings.find((original) => original.listingId === listing.listingId) ?? listing
              );
            }
            if (facts === undefined) {
              return listing;
            }
            const output: RakutenListing = Object.freeze({
              ...listing,
              specifications: applySpecificationFacts(
                listing.specifications ?? emptySpecifications,
                facts,
              ),
              specificationFacts: Object.freeze([...(listing.specificationFacts ?? []), ...facts]),
            });
            descriptions.set(output, descriptions.get(listing) ?? "");
            const evidence = specificationEvidence.get(listing);
            if (evidence !== undefined) {
              specificationEvidence.set(output, evidence);
            }
            return output;
          }),
        ),
      });
    } catch {
      options?.signal?.throwIfAborted();
      return Object.freeze({ listings: Object.freeze(enriched), cacheable: false });
    }
  };

  return async (listings, options) => {
    options?.signal?.throwIfAborted();
    const now = Date.parse(valueOf(clock()));
    if (
      listings.length === 0 ||
      listings.length > 6 ||
      !authorized(clock()) ||
      listings.some((listing) => Date.parse(listing.expiresAt) <= now)
    ) {
      return listings;
    }
    const key = JSON.stringify({
      policy: "rakuten-specifications-v1",
      extractor: extractor?.scope ?? null,
      ai: permitted(configuration.rights.ai, clock()),
      listings: listings.map((listing) => ({
        id: listing.listingId,
        title: listing.title,
        url: listing.canonicalUrl,
        description: descriptions.get(listing) ?? "",
      })),
    });
    const cached = cache.get(key);
    if (cached !== undefined && cached.until > now) {
      return reuseSpecifications(listings, cached.listings, clock());
    }
    for (const [cacheKey, entry] of cache) {
      if (entry.until <= now) {
        cache.delete(cacheKey);
      }
    }
    const pending = options?.signal === undefined ? inflight.get(key) : undefined;
    if (pending !== undefined) {
      return reuseSpecifications(listings, await pending, clock());
    }
    if (inflight.size >= 64) {
      return listings;
    }
    const operation = enrich(listings, options).then((output) => {
      if (authorized(clock()) && output.cacheable) {
        const until = Math.min(
          now + 900_000,
          ...listings.map((listing) => Date.parse(listing.expiresAt)),
        );
        if (cache.size >= 64) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }
        cache.set(key, Object.freeze({ until, listings: output.listings }));
      }
      return output.listings;
    });
    if (options?.signal === undefined) {
      inflight.set(key, operation);
    }
    try {
      return await operation;
    } finally {
      if (options?.signal === undefined) {
        inflight.delete(key);
      }
    }
  };
}
