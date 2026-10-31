import { err, ok } from "../../comparison/algebra.js";
import type { CommerceListing, CommerceProvider } from "../../comparison/commerce.js";
import { valueOf } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import {
  createRakutenLookup,
  createRakutenSearch,
  readRakutenListingCondition,
  readRakutenListingDescription,
} from "./http.js";

export function createRakutenCommerceProviders(
  settings: Parameters<typeof createRakutenSearch>[0],
  clock: () => Instant,
  fetcher: typeof fetch = fetch,
): readonly CommerceProvider[] {
  // Both sources share the existing paced Rakuten transport and URL/link validation.
  const search = createRakutenSearch(settings, clock, fetcher);
  const lookup = createRakutenLookup(settings, clock, fetcher, 3);
  const providers: CommerceProvider[] = [];
  for (const source of ["rakuten", "rakuten_furusato"] satisfies ReadonlyArray<
    "rakuten" | "rakuten_furusato"
  >) {
    const donation = source === "rakuten_furusato";
    providers.push(
      Object.freeze({
        source,
        async request(input, signal) {
          const query =
            donation && input.operation === "search" ? `ふるさと納税 ${input.query}` : input.query;
          if (
            new TextEncoder().encode(query).length > (input.operation === "lookup" ? 2048 : 128)
          ) {
            return err({ code: "invalid_request" });
          }
          const cancellation = signal === undefined ? {} : { signal };
          const result =
            input.operation === "lookup"
              ? await lookup(input.query, null, undefined, cancellation)
              : await search(query, null, undefined, {
                  page: input.page,
                  hits: input.limit,
                  ...(donation ? {} : { excludeKeyword: "ふるさと納税" }),
                  ...cancellation,
                });
          if (result.tag === "err") {
            const code = result.error.code;
            return err({
              code:
                code === "source_not_authorized" ||
                code === "provider_rate_limited" ||
                code === "provider_unauthorized" ||
                code === "provider_unavailable" ||
                code === "listing_not_found"
                  ? code
                  : "invalid_response",
            });
          }
          const raw = "listings" in result.value ? result.value.listings : [result.value];
          const selected = raw.filter(
            (listing) => listing.title.includes("ふるさと納税") === donation,
          );
          if (input.operation === "lookup" && selected.length !== 1) {
            return err({ code: "listing_not_found" });
          }
          const now = clock();
          const listings = selected.map((listing): CommerceListing =>
            Object.freeze({
              source,
              id: listing.listingId,
              title: listing.title,
              url: listing.canonicalUrl,
              affiliateUrl: listing.affiliateUrl,
              description: readRakutenListingDescription(listing),
              imageUrl: listing.imageUrl ?? null,
              amount: Object.freeze({ ...listing.price, kind: donation ? "donation" : "purchase" }),
              priceBasis: "listing",
              condition: donation ? "not_applicable" : readRakutenListingCondition(listing),
              availability: listing.availability,
              shipping: listing.shipping,
              tax: listing.tax,
              observedAt: listing.observedAt,
              expiresAt: listing.expiresAt,
              usage: Object.freeze({ ai: true, priceComparison: true, store: false }),
              notices: Object.freeze([
                donation
                  ? "返礼品の寄付額です。内容量・配送条件・定期便の回数は説明文からの別途確認が必要です。"
                  : listing.notice,
              ]),
            }),
          );
          return ok(
            Object.freeze({
              listings: Object.freeze(listings),
              total: "count" in result.value ? result.value.count : listings.length,
              page: input.page,
              limit: input.operation === "lookup" ? 1 : input.limit,
              observedAt: valueOf(now),
            }),
          );
        },
      }),
    );
  }
  return Object.freeze(providers);
}
