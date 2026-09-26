import { andThen, err, map } from "./algebra.js";
import type { Result } from "./algebra.js";
import { hasProductIdentity, identifyProduct, readListing, readProduct } from "./catalog.js";
import type { IdentifiedProduct, IdentificationError } from "./catalog.js";
import { attempt, readReference, routeProvider } from "./providers.js";
import type {
  ListingReference,
  ProductDataProvider,
  ProviderError,
  UrlError,
} from "./providers.js";
import { permitted, providerOf, sameListingId, valueOf } from "./values.js";
import type { Instant, SchemaError } from "./values.js";

export type Investigation = Readonly<{
  mode: "demo" | "live";
  reference: ListingReference;
  identified: IdentifiedProduct;
}>;
export type InvestigationError =
  | UrlError
  | SchemaError
  | IdentificationError
  | ProviderError
  | Readonly<{ code: "source_not_authorized" | "listing_mismatch" | "future_evidence" }>;

export async function investigateProduct(
  input: string,
  providers: readonly ProductDataProvider[],
  clock: () => Instant,
): Promise<Result<Investigation, InvestigationError>> {
  try {
    return await investigate(input, providers, clock);
  } catch {
    return err({ code: "provider_unavailable" });
  }
}

async function investigate(
  input: string,
  providers: readonly ProductDataProvider[],
  clock: () => Instant,
): Promise<Result<Investigation, InvestigationError>> {
  const startedAt = clock();
  const routed = routeProvider(input, providers);
  if (routed.tag === "err") {
    return routed;
  }
  const { provider, reference } = routed.value;
  if (valueOf(providerOf(readReference(reference).id)) !== valueOf(provider.id)) {
    return err({ code: "provider_mismatch" });
  }
  if (
    !permitted(provider.permissions().fetch, startedAt) ||
    !permitted(provider.permissions().display, startedAt)
  ) {
    return err({ code: "source_not_authorized" });
  }
  const fetched = await attempt(() => provider.fetchListing(reference));
  if (fetched.tag === "err") {
    return fetched;
  }
  const listing = readListing(fetched.value);
  const fetchedAt = clock();
  if (
    !sameListingId(listing.id, readReference(reference).id) ||
    valueOf(listing.evidence.source) !== valueOf(readReference(reference).canonicalUrl)
  ) {
    return err({ code: "listing_mismatch" });
  }
  if (valueOf(listing.evidence.observedAt) > valueOf(fetchedAt)) {
    return err({ code: "future_evidence" });
  }
  if (
    !permitted(listing.permissions.fetch, fetchedAt) ||
    !permitted(listing.permissions.display, fetchedAt)
  ) {
    return err({ code: "source_not_authorized" });
  }
  if (!hasProductIdentity(listing.identity)) {
    return err({ code: "insufficient_identity" });
  }
  if (
    !permitted(provider.permissions().fetch, fetchedAt) ||
    !permitted(provider.permissions().display, fetchedAt)
  ) {
    return err({ code: "source_not_authorized" });
  }
  const searched = await attempt(() => provider.searchProducts(listing.identity));
  return andThen(searched, (products): Result<Investigation, InvestigationError> => {
    const now = clock();
    if (
      !permitted(provider.permissions().fetch, now) ||
      !permitted(provider.permissions().display, now) ||
      !permitted(listing.permissions.fetch, now) ||
      !permitted(listing.permissions.display, now) ||
      products.some(
        (product) =>
          !permitted(readProduct(product).permissions.fetch, now) ||
          !permitted(readProduct(product).permissions.display, now),
      )
    ) {
      return err({ code: "source_not_authorized" });
    }
    if (
      products.some(
        (product) => valueOf(providerOf(readProduct(product).id)) !== valueOf(provider.id),
      )
    ) {
      return err({ code: "provider_mismatch" });
    }
    if (
      products.some((product) => valueOf(readProduct(product).evidence.observedAt) > valueOf(now))
    ) {
      return err({ code: "future_evidence" });
    }
    return map(identifyProduct(fetched.value, products), (identified) =>
      Object.freeze({ mode: provider.mode, reference, identified }),
    );
  });
}
