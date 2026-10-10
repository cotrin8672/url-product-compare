import { err, ok } from "../../comparison/algebra.js";
import type {
  ConsumerAttachedListing,
  ConsumerListing,
  ConsumerProvider,
  ConsumerProviderLookupError,
} from "../../comparison/consumer-provider.js";
import { httpsUrl, permitted, valueOf } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import {
  createRakutenEnricher,
  createRakutenGenreResolver,
  createRakutenLookup,
  createRakutenSearch,
  readRakutenConsumerInformation,
  readRakutenListingCondition,
} from "./http.js";
import type { RakutenListing, RakutenLookupError } from "./http.js";
import { parseRakutenUrl } from "./index.js";

type RakutenConfiguration = Parameters<typeof createRakutenLookup>[0];

function mapLookupError(error: RakutenLookupError): ConsumerProviderLookupError {
  if ("field" in error) {
    return {
      code: error.field.startsWith("rakuten_affiliate")
        ? "invalid_affiliate_url"
        : "provider_unavailable",
    };
  }
  return error;
}

export function createRakutenConsumerProvider(
  configuration: RakutenConfiguration,
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
): ConsumerProvider {
  const lookup = createRakutenLookup(configuration, clock, fetcher, 3);
  const search = createRakutenSearch(configuration, clock, fetcher);
  const enrichListings = createRakutenEnricher(configuration, clock, undefined, fetcher);
  const resolveGenreLineage = createRakutenGenreResolver(configuration, clock, fetcher);
  const rawListings = new WeakMap<ConsumerListing, RakutenListing>();
  const normalize = (raw: RakutenListing): ConsumerListing => {
    const listing: ConsumerListing = Object.freeze({
      provider: "rakuten",
      condition: readRakutenListingCondition(raw),
      listingId: raw.listingId,
      title: raw.title,
      canonicalUrl: raw.canonicalUrl,
      affiliateUrl: raw.affiliateUrl,
      observedAt: raw.observedAt,
      expiresAt: raw.expiresAt,
      shopName: raw.shopName,
      price: raw.price,
      tax: raw.tax,
      shipping: raw.shipping,
      availability: raw.availability,
      mode: raw.mode,
      notice: raw.notice,
      imageUrl: raw.imageUrl ?? null,
      genreId: raw.genreId ?? null,
      identityVerified: raw.identityVerified ?? false,
      gtin: raw.identityVerified === true ? (raw.specifications?.gtin ?? null) : null,
    });
    rawListings.set(listing, raw);
    return listing;
  };
  const provider: ConsumerProvider = {
    metadata: Object.freeze({
      id: "rakuten",
      label: "楽天市場",
      urlHosts: Object.freeze(["item.rakuten.co.jp"]),
      affiliateHosts: Object.freeze(["hb.afl.rakuten.co.jp"]),
    }),
    acceptsUrl(url: string): boolean {
      const parsed = httpsUrl(url);
      if (parsed.tag === "err") {
        return false;
      }
      const reference = parseRakutenUrl(parsed.value);
      return reference.tag === "ok" && reference.value.tag !== "none";
    },
    async lookup(url, keyword, options) {
      const result = await lookup(url, keyword, options?.fallbackKeyword, options);
      return result.tag === "err" ? err(mapLookupError(result.error)) : ok(normalize(result.value));
    },
    resolveGenreLineage,
    categoryMatchesLineage(category, genreId, lineage) {
      const binding = category.providerBindings?.["rakuten"];
      return (
        binding !== undefined && (genreId === binding.genreId || lineage.includes(binding.genreId))
      );
    },
    async search(category, input, options) {
      const binding = category.providerBindings?.["rakuten"];
      if (binding === undefined) {
        return err({ code: "unsupported_category" });
      }
      const result = await search(binding.keyword, null, binding.genreId, {
        page: input.page,
        hits: input.hits,
        invalidAffiliate: "skip",
        ...(binding.searchExcludeKeyword === undefined
          ? {}
          : { excludeKeyword: binding.searchExcludeKeyword }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.tag === "err") {
        return err(mapLookupError(result.error));
      }
      return ok(
        Object.freeze({
          count: result.value.count,
          listings: Object.freeze(result.value.listings.map(normalize)),
        }),
      );
    },
    async enrich(listings, options) {
      const raw = listings.map((listing) => {
        const original = rawListings.get(listing);
        if (original === undefined) {
          throw new Error("Unknown Rakuten listing");
        }
        return original;
      });
      return Object.freeze((await enrichListings(raw, options)).map(normalize));
    },
    attachConsumerInformation(listing, category): ConsumerAttachedListing {
      const raw = rawListings.get(listing);
      if (raw === undefined) {
        throw new Error("Unknown Rakuten listing");
      }
      const attached: ConsumerAttachedListing = Object.freeze({
        ...listing,
        consumerInformation: readRakutenConsumerInformation(raw, category),
      });
      rawListings.set(attached, raw);
      return attached;
    },
    permissions(now: Instant) {
      const store = permitted(configuration.rights.store, now);
      return Object.freeze({
        display: permitted(configuration.rights.display, now),
        fetch: permitted(configuration.rights.fetch, now),
        affiliate: permitted(configuration.rights.affiliate, now),
        ai: permitted(configuration.rights.ai, now),
        store,
        storeExpiresAt:
          store && configuration.rights.store.status === "granted"
            ? valueOf(configuration.rights.store.expiresAt)
            : null,
      });
    },
  };
  return Object.freeze(provider);
}
