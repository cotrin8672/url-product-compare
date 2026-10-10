import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { consumerListingConditionEligible, defaultConsumerCatalog } from "./consumer-catalog.js";
import type { ConsumerCatalog, ConsumerCatalogCategory } from "./consumer-catalog.js";
import type {
  ConsumerAttachedListing,
  ConsumerListing,
  ConsumerProvider,
  ConsumerProviderLookupError,
  ConsumerProviderMetadata,
} from "./consumer-provider.js";
import {
  applyConsumerChoices,
  assessConsumerListing,
  compareConsumerListings,
  consumerConditionsSchema,
} from "./consumer.js";
import type { ConsumerComparisonProduct, ConsumerExtraction, ConsumerSort } from "./consumer.js";
import { httpsUrl, instant, valueOf } from "./values.js";
import type { Instant } from "./values.js";

function readServiceClock(clock?: () => Instant): Instant {
  if (clock !== undefined) {
    return clock();
  }
  const parsed = instant(new Date().toISOString());
  if (parsed.tag === "err") {
    throw new Error("clock_unavailable");
  }
  return parsed.value;
}

export type ConsumerServiceOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (
    progress: Readonly<{ stage: string; pages: number; examined: number }>,
  ) => Promise<void>;
}>;

export type ConsumerDetectResult = Readonly<{
  status: "detected" | "needs_confirmation" | "unsupported";
  source: ConsumerListing | null;
  categories: readonly string[];
  category: string | null;
}>;

export type ConsumerServiceError =
  | ConsumerProviderLookupError
  | Readonly<{
      code:
        | "invalid_request"
        | "ambiguous_product"
        | "ambiguous_provider"
        | "needs_confirmation"
        | "internal_error";
    }>;

export type ConsumerComparisonResult = Readonly<{
  category: string;
  categoryDefinition: ConsumerCatalogCategory;
  providerDefinitions: readonly ConsumerProviderMetadata[];
  storageExpiresAt: string | null;
  conditions: Readonly<Record<string, number | boolean>>;
  sort: ConsumerSort;
  source: ConsumerAttachedListing;
  aiCalls: Readonly<{ openai: number; jev: number }>;
  extractionStatus: "not_needed" | "not_configured" | "applied" | "unavailable";
  search: Readonly<{
    pages: number;
    examined: number;
    duplicates: number;
    excluded: number;
    pending: number;
    stopReason:
      | "enough_candidates"
      | "exhausted"
      | "search_limit"
      | "time_limit"
      | "provider_error";
  }>;
  status: "ranked" | "compared" | "needs_information" | "no_match";
  products: ReadonlyArray<ConsumerComparisonProduct<ConsumerAttachedListing>>;
}>;

function publicListing(listing: ConsumerAttachedListing): ConsumerAttachedListing {
  return Object.freeze({
    ...listing,
    consumerInformation: Object.freeze({
      ...listing.consumerInformation,
      choices: Object.freeze([]),
    }),
  });
}

function selectProvider(
  providers: readonly ConsumerProvider[],
  url: string,
): Result<ConsumerProvider, ConsumerServiceError> {
  const matches = providers.filter((provider) => provider.acceptsUrl(url));
  const provider = matches[0];
  return matches.length > 1
    ? err({ code: "ambiguous_provider" })
    : provider === undefined
      ? err({ code: "unsupported_url" })
      : ok(provider);
}

function validAffiliate(listing: ConsumerListing, provider: ConsumerProvider): boolean {
  const url = httpsUrl(listing.affiliateUrl);
  return (
    url.tag === "ok" &&
    listing.provider === provider.metadata.id &&
    provider.metadata.affiliateHosts.includes(new URL(valueOf(url.value)).hostname)
  );
}

async function reportProgress(
  options: ConsumerServiceOptions | undefined,
  progress: Readonly<{ stage: string; pages: number; examined: number }>,
): Promise<void> {
  if (options?.signal?.aborted === true) {
    throw new Error("aborted");
  }
  if (options?.onProgress !== undefined) {
    await options.onProgress(progress);
  }
}

export function createConsumerComparisonService(
  providers: readonly ConsumerProvider[],
  extraction?: ConsumerExtraction,
  clock?: () => Instant,
  catalog: ConsumerCatalog = defaultConsumerCatalog,
): {
  catalog: () => readonly ConsumerCatalogCategory[];
  providerDefinitions: () => readonly ConsumerProviderMetadata[];
  canStoreResult: (url: string) => boolean;
  detect: (
    input: Readonly<{ url: string; keyword: string | null }>,
    options?: ConsumerServiceOptions,
  ) => Promise<Result<ConsumerDetectResult, ConsumerServiceError>>;
  compare: (
    input: Readonly<{
      url: string;
      keyword: string | null;
      category: string | null;
      conditions: unknown;
      sort: ConsumerSort;
    }>,
    options?: ConsumerServiceOptions,
  ) => Promise<Result<ConsumerComparisonResult, ConsumerServiceError>>;
} {
  if (new Set(providers.map((provider) => provider.metadata.id)).size !== providers.length) {
    throw new Error("Duplicate consumer provider id");
  }
  const providerDefinitions = Object.freeze(providers.map((provider) => provider.metadata));
  const service: ReturnType<typeof createConsumerComparisonService> = {
    catalog(): readonly ConsumerCatalogCategory[] {
      return catalog.publicCategories();
    },
    providerDefinitions(): readonly ConsumerProviderMetadata[] {
      return providerDefinitions;
    },
    canStoreResult(url: string): boolean {
      const selected = selectProvider(providers, url);
      if (selected.tag === "err") {
        return false;
      }
      const now = readServiceClock(clock);
      const storage = selected.value.permissions(now);
      return (
        storage.store && storage.storeExpiresAt !== null && storage.storeExpiresAt > valueOf(now)
      );
    },
    async detect(input, options): Promise<Result<ConsumerDetectResult, ConsumerServiceError>> {
      options?.signal?.throwIfAborted();
      const selected = selectProvider(providers, input.url);
      if (selected.tag === "err") {
        return selected;
      }
      const provider = selected.value;
      const permissions = provider.permissions(readServiceClock(clock));
      if (!permissions.display || !permissions.fetch || !permissions.affiliate) {
        return err({ code: "provider_unavailable" });
      }
      const lookup = await provider.lookup(input.url, input.keyword, options);
      if (lookup.tag === "err") {
        return err(lookup.error);
      }
      options?.signal?.throwIfAborted();
      if (!validAffiliate(lookup.value, provider)) {
        return err({ code: "invalid_affiliate_url" });
      }
      const now = readServiceClock(clock);
      if (lookup.value.expiresAt <= valueOf(now) || !provider.permissions(now).display) {
        return err({ code: "source_not_authorized" });
      }
      if (!consumerListingConditionEligible(lookup.value.condition)) {
        return ok(
          Object.freeze({
            status: "unsupported",
            source: lookup.value,
            categories: Object.freeze([]),
            category: null,
          }),
        );
      }
      const lineage = await provider.resolveGenreLineage(lookup.value.genreId ?? null, options);
      options?.signal?.throwIfAborted();
      const categories = Object.freeze(
        catalog.categories
          .filter((category) =>
            provider.categoryMatchesLineage(category, lookup.value.genreId, lineage),
          )
          .map((category) => category.id),
      );
      if (categories.length === 1) {
        return ok(
          Object.freeze({
            status: "detected",
            source: lookup.value,
            categories,
            category: categories[0] ?? null,
          }),
        );
      }
      if (categories.length > 1) {
        return ok(
          Object.freeze({
            status: "needs_confirmation",
            source: lookup.value,
            categories,
            category: null,
          }),
        );
      }
      return ok(
        Object.freeze({ status: "unsupported", source: lookup.value, categories, category: null }),
      );
    },
    async compare(input, options): Promise<Result<ConsumerComparisonResult, ConsumerServiceError>> {
      const categoryId = input.category ?? null;
      if (categoryId === null) {
        const detected = await service.detect({ url: input.url, keyword: input.keyword }, options);
        if (detected.tag === "err") {
          return detected;
        }
        if (detected.value.status !== "detected" || detected.value.category === null) {
          return err({
            code:
              detected.value.status === "needs_confirmation"
                ? "needs_confirmation"
                : "unsupported_category",
          });
        }
        return await service.compare({ ...input, category: detected.value.category }, options);
      }
      const category = catalog.category(categoryId);
      const checked =
        category === null ? null : consumerConditionsSchema(category).parse(input.conditions);
      if (category === null || checked?.tag !== "ok") {
        return err({ code: "invalid_request" });
      }
      const selected = selectProvider(providers, input.url);
      if (selected.tag === "err") {
        return selected;
      }
      const provider = selected.value;
      const permissions = provider.permissions(readServiceClock(clock));
      if (!permissions.display || !permissions.fetch || !permissions.affiliate) {
        return err({ code: "provider_unavailable" });
      }
      const publicCategory = catalog.publicCategories().find((entry) => entry.id === category.id);
      if (publicCategory === undefined) {
        return err({ code: "internal_error" });
      }
      const deadline = Date.now() + 35_000;
      await reportProgress(options, { stage: "lookup", pages: 0, examined: 0 });
      const providerBinding = category.providerBindings?.[provider.metadata.id];
      const original = await provider.lookup(input.url, input.keyword, {
        ...options,
        ...(providerBinding === undefined ? {} : { fallbackKeyword: providerBinding.keyword }),
      });
      if (original.tag === "err") {
        return err(original.error);
      }
      options?.signal?.throwIfAborted();
      if (!validAffiliate(original.value, provider)) {
        return err({ code: "invalid_affiliate_url" });
      }
      if (!consumerListingConditionEligible(original.value.condition)) {
        return err({ code: "listing_not_eligible" });
      }
      const lineage = await provider.resolveGenreLineage(original.value.genreId ?? null, options);
      if (!provider.categoryMatchesLineage(category, original.value.genreId ?? null, lineage)) {
        return err({ code: "unsupported_category" });
      }
      options?.signal?.throwIfAborted();
      const attach = (listing: ConsumerListing): ConsumerAttachedListing =>
        provider.attachConsumerInformation(listing, category);
      const originalEnriched = await provider.enrich([original.value], options);
      const first = originalEnriched[0];
      if (first === undefined) {
        return err({ code: "listing_not_found" });
      }
      options?.signal?.throwIfAborted();
      if (!consumerListingConditionEligible(first.condition) || !validAffiliate(first, provider)) {
        return err({ code: "listing_not_eligible" });
      }
      let collected: ConsumerAttachedListing[] = [attach(first)];
      const sourceInformation = collected[0]?.consumerInformation;
      // Detail-only fields must not shrink the candidate pool for the primary comparison.
      const comparableAxes = category.axes
        .filter((axis) => axis.id !== "price")
        .slice(0, 6)
        .filter((axis) => typeof sourceInformation?.specs[axis.id] === "number");
      const hasComparableSpecifications = (listing: ConsumerAttachedListing): boolean =>
        comparableAxes.length > 0 &&
        comparableAxes.every(
          (axis) => typeof listing.consumerInformation.specs[axis.id] === "number",
        );
      const listingUrls = new Map<string, string>([[first.listingId, first.canonicalUrl]]);
      const seenUrls = new Set([first.canonicalUrl]);
      const seenProducts = new Set<string>(
        first.identityVerified === true && typeof first.gtin === "string" ? [first.gtin] : [],
      );
      const genreLineages = new Map<string, readonly string[]>([[first.genreId ?? "", lineage]]);
      let pages = 0;
      let examined = 0;
      let duplicates = 0;
      let stopReason: ConsumerComparisonResult["search"]["stopReason"] = "search_limit";
      for (let page = 1; page <= 3; page += 1) {
        options?.signal?.throwIfAborted();
        if (Date.now() >= deadline) {
          stopReason = "time_limit";
          break;
        }
        const found = await provider.search(category, { page, hits: 6 }, options);
        if (found.tag === "err") {
          stopReason = "provider_error";
          break;
        }
        pages += 1;
        await reportProgress(options, { stage: "search", pages, examined });
        const batch: ConsumerListing[] = [];
        for (const listing of found.value.listings) {
          examined += 1;
          options?.signal?.throwIfAborted();
          if (
            !consumerListingConditionEligible(listing.condition) ||
            !validAffiliate(listing, provider)
          ) {
            continue;
          }
          const knownUrl = listingUrls.get(listing.listingId);
          if (knownUrl !== undefined && knownUrl !== listing.canonicalUrl) {
            return err({ code: "ambiguous_product" });
          }
          if (knownUrl !== undefined || seenUrls.has(listing.canonicalUrl)) {
            duplicates += 1;
            continue;
          }
          listingUrls.set(listing.listingId, listing.canonicalUrl);
          seenUrls.add(listing.canonicalUrl);
          const genreId = listing.genreId ?? "";
          let listingLineage = genreLineages.get(genreId);
          if (listingLineage === undefined && Date.now() < deadline) {
            listingLineage = provider.categoryMatchesLineage(category, listing.genreId ?? null, [])
              ? Object.freeze([])
              : await provider.resolveGenreLineage(listing.genreId ?? null, options);
            genreLineages.set(genreId, listingLineage);
          }
          if (
            listingLineage !== undefined &&
            provider.categoryMatchesLineage(category, listing.genreId ?? null, listingLineage) &&
            batch.length < 6
          ) {
            batch.push(listing);
          }
        }
        if (Date.now() >= deadline) {
          stopReason = "time_limit";
          break;
        }
        for (const listing of await provider.enrich(batch, options)) {
          options?.signal?.throwIfAborted();
          if (
            !consumerListingConditionEligible(listing.condition) ||
            !validAffiliate(listing, provider)
          ) {
            continue;
          }
          const gtin =
            listing.identityVerified === true && typeof listing.gtin === "string"
              ? listing.gtin
              : null;
          if (gtin !== null) {
            if (seenProducts.has(gtin)) {
              duplicates += 1;
              continue;
            }
            seenProducts.add(gtin);
          }
          collected.push(attach(listing));
        }
        if (
          collected
            .slice(1)
            .filter(
              (listing) =>
                assessConsumerListing(listing, category, checked.value).status === "eligible" &&
                (input.sort !== "recommendation" || hasComparableSpecifications(listing)),
            ).length >= 5
        ) {
          stopReason = "enough_candidates";
          break;
        }
        if (found.value.listings.length === 0 || found.value.count <= page * 6) {
          stopReason = "exhausted";
          break;
        }
      }
      let jevCalls = 0;
      let extractionStatus: ConsumerComparisonResult["extractionStatus"] = "not_needed";
      const choices = collected
        .flatMap((listing) => listing.consumerInformation.choices)
        .slice(0, 24);
      if (choices.length > 0) {
        extractionStatus = "not_configured";
        if (
          extraction !== undefined &&
          permissions.ai &&
          Date.now() < deadline + 10_000 &&
          options?.signal?.aborted !== true
        ) {
          jevCalls = 1;
          const answers = await extraction(choices, options);
          options?.signal?.throwIfAborted();
          extractionStatus = answers.tag === "ok" ? "applied" : "unavailable";
          if (answers.tag === "ok") {
            collected = collected.map((listing) =>
              Object.freeze({
                ...listing,
                consumerInformation: applyConsumerChoices(
                  listing.consumerInformation,
                  answers.value,
                ),
              }),
            );
          }
        }
      }
      const now = readServiceClock(clock);
      options?.signal?.throwIfAborted();
      if (
        collected.some((listing) => listing.expiresAt <= valueOf(now)) ||
        !provider.permissions(now).display
      ) {
        return err({ code: "source_not_authorized" });
      }
      const assessed = collected
        .slice(1)
        .map((listing) => ({
          listing,
          assessment: assessConsumerListing(listing, category, checked.value),
        }));
      const comparable = assessed.filter(
        (entry) =>
          entry.assessment.status === "eligible" && hasComparableSpecifications(entry.listing),
      );
      const preferred = (
        input.sort === "recommendation" && comparable.length > 0 ? comparable : assessed
      )
        .toSorted((left, right) => {
          const order = { eligible: 0, pending: 1, excluded: 2 };
          const difference = order[left.assessment.status] - order[right.assessment.status];
          return difference !== 0
            ? difference
            : input.sort === "price"
              ? left.listing.price.minimum - right.listing.price.minimum
              : 0;
        })
        .slice(0, 5)
        .map((entry) => entry.listing);
      const source = collected[0];
      if (source === undefined) {
        return err({ code: "internal_error" });
      }
      const compared = compareConsumerListings(
        [publicListing(source), ...preferred.map(publicListing)],
        category,
        checked.value,
        input.sort,
      );
      const storage = provider.permissions(now);
      const storageExpiresAt =
        storage.store && storage.storeExpiresAt !== null && storage.storeExpiresAt > valueOf(now)
          ? new Date(
              Math.min(
                Date.parse(storage.storeExpiresAt),
                ...compared.products.map((listing) => Date.parse(listing.expiresAt)),
              ),
            ).toISOString()
          : null;
      return ok(
        Object.freeze({
          category: category.id,
          categoryDefinition: publicCategory,
          providerDefinitions,
          storageExpiresAt,
          conditions: checked.value,
          sort: input.sort,
          source: publicListing(source),
          aiCalls: Object.freeze({ openai: 0, jev: jevCalls }),
          extractionStatus,
          search: Object.freeze({
            pages,
            examined,
            duplicates,
            excluded: assessed.filter((entry) => entry.assessment.status === "excluded").length,
            pending: assessed.filter((entry) => entry.assessment.status === "pending").length,
            stopReason,
          }),
          status: compared.status,
          products: compared.products,
        }),
      );
    },
  };
  return service;
}
