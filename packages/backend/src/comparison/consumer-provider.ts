import type { Result } from "./algebra.js";
import type { ConsumerCategoryDefinition, ConsumerListingCondition } from "./consumer-catalog.js";
import type { ConsumerInformation } from "./consumer.js";
import type { Instant } from "./values.js";

export type ConsumerProviderMetadata = Readonly<{
  id: string;
  label: string;
  urlHosts: readonly string[];
  affiliateHosts: readonly string[];
  automaticCategories?: boolean;
}>;

type ConsumerListingPrice = Readonly<{ minimum: number; maximum: number; currency: "JPY" }>;

export type ConsumerListing = Readonly<{
  provider: string;
  condition: ConsumerListingCondition;
  listingId: string;
  title: string;
  canonicalUrl: string;
  affiliateUrl: string;
  observedAt: string;
  expiresAt: string;
  shopName: string;
  price: ConsumerListingPrice;
  tax: "included" | "excluded";
  shipping: "included" | "excluded";
  availability: "available" | "unavailable";
  imageUrl?: string | null;
  identityVerified?: boolean;
  genreId?: string | null;
  consumerInformation?: ConsumerInformation;
  notice?: string;
  mode?: "live";
  gtin?: string | null;
}>;

export type ConsumerAttachedListing = ConsumerListing &
  Readonly<{ consumerInformation: ConsumerInformation }>;

type ConsumerProviderProgress = Readonly<{ stage: string; pages: number; examined: number }>;

type ConsumerProviderOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: ConsumerProviderProgress) => Promise<void>;
  fallbackKeyword?: string;
}>;

export type ConsumerProviderLookupError = Readonly<{
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
    | "provider_rate_limited"
    | "unsupported_category"
    | "listing_not_eligible"
    | "invalid_affiliate_url";
}>;

export type ConsumerProvider = Readonly<{
  metadata: ConsumerProviderMetadata;
  acceptsUrl: (url: string) => boolean;
  lookup: (
    url: string,
    keyword: string | null,
    options?: ConsumerProviderOptions,
  ) => Promise<Result<ConsumerListing, ConsumerProviderLookupError>>;
  resolveGenreLineage: (
    genreId: string | null | undefined,
    options?: ConsumerProviderOptions,
  ) => Promise<readonly string[]>;
  discoverCategory?: (
    genreId: string | null | undefined,
    options?: ConsumerProviderOptions,
  ) => Promise<ConsumerDiscoveredCategory | null>;
  categoryMatchesLineage: (
    category: ConsumerCategoryDefinition,
    genreId: string | null | undefined,
    lineage: readonly string[],
  ) => boolean;
  search: (
    category: ConsumerCategoryDefinition,
    input: Readonly<{ page: number; hits: number; source?: ConsumerListing }>,
    options?: ConsumerProviderOptions,
  ) => Promise<
    Result<
      Readonly<{ count: number; listings: readonly ConsumerListing[] }>,
      ConsumerProviderLookupError
    >
  >;
  enrich: (
    listings: readonly ConsumerListing[],
    options?: ConsumerProviderOptions,
  ) => Promise<readonly ConsumerListing[]>;
  attachConsumerInformation: (
    listing: ConsumerListing,
    category: ConsumerCategoryDefinition,
  ) => ConsumerAttachedListing;
  permissions: (
    now: Instant,
  ) => Readonly<{
    display: boolean;
    fetch: boolean;
    affiliate: boolean;
    ai: boolean;
    store: boolean;
    storeExpiresAt: string | null;
  }>;
}>;

export type ConsumerCategorySelectionStatus =
  | "applied"
  | "not_configured"
  | "unavailable"
  | "no_attributes";

export type ConsumerDiscoveredCategory = Readonly<{
  definition: ConsumerCategoryDefinition;
  aiCalls: number;
  status: ConsumerCategorySelectionStatus;
}>;

export type ConsumerCategoryAttribute = Readonly<{ id: number; label: string }>;

export type ConsumerCategorySelection = (
  label: string,
  attributes: readonly ConsumerCategoryAttribute[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<Result<readonly number[], "unavailable" | "invalid_response">>;
