import { andThen, err, map, none, ok, some } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { listingSchema, productsSchema } from "../../comparison/catalog.js";
import type { Identity } from "../../comparison/catalog.js";
import { attempt, referenceSchema } from "../../comparison/providers.js";
import type {
  ListingReference,
  ProductDataProvider,
  ProviderError,
} from "../../comparison/providers.js";
import { providerId, valueOf } from "../../comparison/values.js";
import type { Permissions, SchemaError } from "../../comparison/values.js";

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
      parseUrl: (input) => {
        const url = new URL(valueOf(input));
        if (url.hostname !== "item.rakuten.co.jp") {
          return ok(none);
        }
        const segments = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
        const shop = segments?.[1];
        const item = segments?.[2];
        const tracking = [
          "scid",
          "s-id",
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "utm_term",
          "utm_content",
        ];
        if (
          shop === undefined ||
          item === undefined ||
          [...url.searchParams.keys()].some((key) => !tracking.includes(key))
        ) {
          return err({ code: "unsupported_url" });
        }
        return map(
          referenceSchema.parse({
            provider: valueOf(id),
            listingId: `${shop}:${item}`,
            canonicalUrl: `https://item.rakuten.co.jp/${shop}/${item}/`,
          }),
          some,
        );
      },
      fetchListing: async (reference) =>
        andThen(await attempt(() => transport.fetchListing(reference)), listingSchema.parse),
      searchProducts: async (identity) =>
        andThen(await attempt(() => transport.searchProducts(identity)), productsSchema.parse),
    }),
  );
}
