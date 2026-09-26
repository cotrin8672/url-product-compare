import { andThen, err, map, ok } from "./algebra.js";
import type { Option, Result } from "./algebra.js";
import type { Identity, Listing, Product } from "./catalog.js";
import { httpsUrl, listingId, providerId, record, valueOf } from "./values.js";
import type {
  HttpsUrl,
  ListingId,
  Permissions,
  ProviderId,
  Schema,
  SchemaError,
} from "./values.js";

const referenceData = Symbol("referenceData");
type ReferenceData = Readonly<{ id: ListingId; canonicalUrl: HttpsUrl }>;
export type ListingReference = Readonly<{ [referenceData]: ReferenceData }>;
export function readReference(reference: ListingReference): ReferenceData {
  return reference[referenceData];
}

export const referenceSchema: Schema<ListingReference> = Object.freeze({
  parse(input: unknown): Result<ListingReference, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "reference" });
    }
    return andThen(providerId(input["provider"]), (provider) =>
      andThen(listingId(provider, input["listingId"]), (id) =>
        map(httpsUrl(input["canonicalUrl"]), (canonicalUrl) =>
          Object.freeze({ [referenceData]: Object.freeze({ id, canonicalUrl }) }),
        ),
      ),
    );
  },
});

export type ProviderError =
  | Readonly<{ code: "listing_not_found" | "provider_unavailable" }>
  | SchemaError;
export type UrlError = Readonly<{
  code:
    | "invalid_url"
    | "unsafe_url"
    | "unsupported_url"
    | "ambiguous_provider"
    | "provider_mismatch";
}>;
export type ProductDataProvider = Readonly<{
  id: ProviderId;
  mode: "demo" | "live";
  permissions: () => Permissions;
  parseUrl: (url: HttpsUrl) => Result<Option<ListingReference>, UrlError | SchemaError>;
  fetchListing: (reference: ListingReference) => Promise<Result<Listing, ProviderError>>;
  searchProducts: (identity: Identity) => Promise<Result<readonly Product[], ProviderError>>;
}>;

export async function attempt<T>(
  effect: () => Promise<Result<T, ProviderError>>,
): Promise<Result<T, ProviderError>> {
  try {
    return await effect();
  } catch {
    return err({ code: "provider_unavailable" });
  }
}

export function routeProvider(
  input: string,
  providers: readonly ProductDataProvider[],
): Result<
  Readonly<{ provider: ProductDataProvider; reference: ListingReference }>,
  UrlError | SchemaError
> {
  const url = httpsUrl(input);
  if (url.tag === "err") {
    return err({ code: "invalid_url" });
  }
  if (new Set(providers.map((provider) => valueOf(provider.id))).size !== providers.length) {
    return err({ code: "ambiguous_provider" });
  }
  const parsed = providers.map((provider) =>
    map(provider.parseUrl(url.value), (reference) => Object.freeze({ provider, reference })),
  );
  const failure = parsed.find((result) => result.tag === "err");
  if (failure !== undefined) {
    return failure;
  }
  const matches = parsed.flatMap((result) =>
    result.tag === "ok" && result.value.reference.tag === "some"
      ? [
          Object.freeze({
            provider: result.value.provider,
            reference: result.value.reference.value,
          }),
        ]
      : [],
  );
  if (matches.length > 1) {
    return err({ code: "ambiguous_provider" });
  }
  const [match] = matches;
  return match === undefined ? err({ code: "unsupported_url" }) : ok(match);
}
