import { andThen, err, map, none, ok, some } from "../../comparison/algebra.js";
import type { Option, Result } from "../../comparison/algebra.js";
import { listingSchema, productsSchema } from "../../comparison/catalog.js";
import type { Identity } from "../../comparison/catalog.js";
import { attempt, referenceSchema } from "../../comparison/providers.js";
import type {
  ListingReference,
  ProductDataProvider,
  ProviderError,
} from "../../comparison/providers.js";
import { providerId, valueOf } from "../../comparison/values.js";
import type { HttpsUrl, Permissions, SchemaError } from "../../comparison/values.js";

export function parseRakutenUrl(
  input: HttpsUrl,
): Result<Option<ListingReference>, Readonly<{ code: "unsupported_url" }> | SchemaError> {
  const url = new URL(valueOf(input));
  if (url.hostname !== "item.rakuten.co.jp") {
    return ok(none);
  }
  const segments = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
  const shop = segments?.[1];
  const item = segments?.[2];
  const tracking = [
    "scid",
    "rafcid",
    "s-id",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "l-id",
    "l2-id",
    "iasid",
    "gclid",
    "icm_agid",
    "icm_acid",
    "icm_cid",
  ];
  if (
    shop === undefined ||
    item === undefined ||
    [...url.searchParams.keys()].some((key) => !tracking.includes(key))
  ) {
    return err({ code: "unsupported_url" });
  }
  // This is a URL reference, not the API's itemCode. Those identifiers can differ.
  return map(
    referenceSchema.parse({
      provider: "rakuten",
      listingId: `${shop}:${item}`,
      canonicalUrl: `https://item.rakuten.co.jp/${shop}/${item}/`,
    }),
    some,
  );
}

export type RakutenTransport = Readonly<{
  mode: "demo" | "live";
  permissions: () => Permissions;
  fetchListing: (reference: ListingReference) => Promise<Result<unknown, ProviderError>>;
  searchProducts: (identity: Identity) => Promise<Result<unknown, ProviderError>>;
}>;

// Transport supplies normalized licensed data; this is not a Rakuten HTTP API integration.
export function rakutenProvider(
  transport: RakutenTransport,
): Result<ProductDataProvider, SchemaError> {
  return map(providerId("rakuten"), (id): ProductDataProvider =>
    Object.freeze({
      id,
      mode: transport.mode,
      permissions: transport.permissions,
      parseUrl: parseRakutenUrl,
      fetchListing: async (reference) =>
        andThen(await attempt(() => transport.fetchListing(reference)), listingSchema.parse),
      searchProducts: async (identity) =>
        andThen(await attempt(() => transport.searchProducts(identity)), productsSchema.parse),
    }),
  );
}
