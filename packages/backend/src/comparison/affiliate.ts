import { andThen, err, map, none, ok, some } from "./algebra.js";
import type { Option, Result } from "./algebra.js";
import { parseVariant, readIdentified, readListing, readProduct, sameVariant } from "./catalog.js";
import type { IdentifiedProduct, Variant } from "./catalog.js";
import { attempt } from "./providers.js";
import type { ProviderError } from "./providers.js";
import {
  httpsUrl,
  instant,
  listingId,
  permitted,
  productId,
  providerId,
  record,
  sameListingId,
  sameProductId,
  valueOf,
} from "./values.js";
import type {
  HttpsUrl,
  Instant,
  ListingId,
  Permissions,
  ProductId,
  ProviderId,
  Schema,
  SchemaError,
} from "./values.js";

const linkData = Symbol("linkData");
const verifiedData = Symbol("verifiedData");
type LinkData = Readonly<{
  provider: ProviderId;
  productId: ProductId;
  listingId: ListingId;
  variant: Variant;
  url: HttpsUrl;
  destination: HttpsUrl;
  expiresAt: Instant;
  kind: "purchase_offer" | "product_info";
}>;
export type AffiliateLink = Readonly<{ [linkData]: LinkData }>;
export type VerifiedAffiliateLink = Readonly<{ [verifiedData]: LinkData }>;
export function readAffiliateLink(link: AffiliateLink): LinkData {
  return link[linkData];
}
export type AffiliateProvider = Readonly<{
  id: ProviderId;
  permissions: () => Permissions;
  trackingHosts: readonly string[];
  resolveLink: (
    product: IdentifiedProduct,
  ) => Promise<Result<Option<AffiliateLink>, ProviderError>>;
  verifyDestination: (
    link: AffiliateLink,
    product: IdentifiedProduct,
  ) => Promise<Result<boolean, ProviderError>>;
}>;

export const affiliateLinkSchema: Schema<AffiliateLink> = Object.freeze({
  parse(input: unknown): Result<AffiliateLink, SchemaError> {
    if (
      !record(input) ||
      (input["kind"] !== "purchase_offer" && input["kind"] !== "product_info")
    ) {
      return err({ code: "invalid_data", field: "affiliate_link" });
    }
    const kind = input["kind"];
    return andThen(providerId(input["provider"]), (provider) =>
      andThen(providerId(input["catalogProvider"]), (catalog) =>
        andThen(productId(catalog, input["productId"]), (product) =>
          andThen(listingId(catalog, input["listingId"]), (listing) =>
            andThen(parseVariant(input["variant"]), (variant) =>
              andThen(httpsUrl(input["url"]), (url) =>
                andThen(httpsUrl(input["destination"]), (destination) =>
                  map(instant(input["expiresAt"]), (expiresAt) =>
                    Object.freeze({
                      [linkData]: Object.freeze({
                        provider,
                        productId: product,
                        listingId: listing,
                        variant,
                        url,
                        destination,
                        expiresAt,
                        kind,
                      }),
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  },
});

export function readVerifiedLink(link: VerifiedAffiliateLink): LinkData {
  return link[verifiedData];
}
export type AffiliateError =
  | ProviderError
  | Readonly<{
      code:
        | "affiliate_not_authorized"
        | "affiliate_target_mismatch"
        | "affiliate_link_expired"
        | "unsafe_affiliate_link"
        | "ambiguous_affiliate_provider"
        | "affiliate_provider_not_found";
    }>;

export function selectAffiliateProvider(
  id: ProviderId,
  providers: readonly AffiliateProvider[],
): Result<AffiliateProvider, AffiliateError> {
  const matches = providers.filter((provider) => valueOf(provider.id) === valueOf(id));
  if (matches.length > 1) {
    return err({ code: "ambiguous_affiliate_provider" });
  }
  const [selected] = matches;
  return selected === undefined ? err({ code: "affiliate_provider_not_found" }) : ok(selected);
}

export async function resolveAffiliateLink(
  identified: IdentifiedProduct,
  provider: AffiliateProvider,
  clock: () => Instant,
): Promise<Result<Option<VerifiedAffiliateLink>, AffiliateError>> {
  try {
    return await resolve(identified, provider, clock);
  } catch {
    return err({ code: "provider_unavailable" });
  }
}

async function resolve(
  identified: IdentifiedProduct,
  provider: AffiliateProvider,
  clock: () => Instant,
): Promise<Result<Option<VerifiedAffiliateLink>, AffiliateError>> {
  const matched = readIdentified(identified);
  const listing = readListing(matched.listing);
  const product = readProduct(matched.product);
  const authorized = (): boolean => {
    const now = clock();
    return (
      permitted(provider.permissions().affiliate, now) &&
      permitted(provider.permissions().display, now) &&
      permitted(listing.permissions.affiliate, now) &&
      permitted(listing.permissions.display, now) &&
      permitted(product.permissions.affiliate, now) &&
      permitted(product.permissions.display, now)
    );
  };
  if (!authorized()) {
    return err({ code: "affiliate_not_authorized" });
  }
  const result = await attempt(() => provider.resolveLink(identified));
  const checked = andThen(result, (option): Result<Option<AffiliateLink>, AffiliateError> => {
    if (!authorized()) {
      return err({ code: "affiliate_not_authorized" });
    }
    if (option.tag === "none") {
      return ok(none);
    }
    const link = option.value[linkData];
    if (
      valueOf(link.provider) !== valueOf(provider.id) ||
      !sameProductId(link.productId, product.id) ||
      !sameListingId(link.listingId, listing.id) ||
      !sameVariant(link.variant, product.identity.variant) ||
      valueOf(link.destination) !==
        valueOf(link.kind === "purchase_offer" ? listing.evidence.source : product.evidence.source)
    ) {
      return err({ code: "affiliate_target_mismatch" });
    }
    if (valueOf(link.expiresAt) <= valueOf(clock())) {
      return err({ code: "affiliate_link_expired" });
    }
    if (!provider.trackingHosts.includes(new URL(valueOf(link.url)).hostname)) {
      return err({ code: "unsafe_affiliate_link" });
    }
    return ok(option);
  });
  if (checked.tag === "err") {
    return checked;
  }
  if (checked.value.tag === "none") {
    return ok(none);
  }
  const candidate = checked.value.value;
  const verified = await attempt(() => provider.verifyDestination(candidate, identified));
  if (verified.tag === "err") {
    return verified;
  }
  if (!authorized()) {
    return err({ code: "affiliate_not_authorized" });
  }
  if (!verified.value) {
    return err({ code: "affiliate_target_mismatch" });
  }
  const link = candidate[linkData];
  if (valueOf(link.expiresAt) <= valueOf(clock())) {
    return err({ code: "affiliate_link_expired" });
  }
  return ok(some(Object.freeze({ [verifiedData]: link })));
}
