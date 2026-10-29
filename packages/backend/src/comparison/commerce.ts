import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import type { FurusatoOverallScoring } from "./furusato-scoring.js";
import { scoreFurusatoListings } from "./furusato-scoring.js";
import { compareFurusatoListings } from "./furusato.js";
import type { FurusatoComparison } from "./furusato.js";
import { record } from "./values.js";

export type CommerceSource = "rakuten" | "yahoo" | "amazon" | "rakuten_furusato" | "satofull";
export type CommerceError = Readonly<{
  code:
    | "invalid_request"
    | "not_configured"
    | "source_not_authorized"
    | "provider_unavailable"
    | "provider_unauthorized"
    | "provider_rate_limited"
    | "invalid_response"
    | "listing_not_found";
}>;
type CommerceInput = Readonly<{
  source: CommerceSource;
  operation: "search" | "lookup";
  query: string;
  page: number;
  limit: number;
}>;
export type CommerceListing = Readonly<{
  source: CommerceSource;
  id: string;
  title: string;
  url: string;
  affiliateUrl: string;
  description: string | null;
  imageUrl?: string | null;
  amount: Readonly<{
    minimum: number;
    maximum: number;
    currency: "JPY";
    kind: "purchase" | "donation";
  }> | null;
  priceBasis: "listing" | "featured_offer";
  condition: "new" | "used" | "refurbished" | "unknown" | "not_applicable";
  availability: "available" | "unavailable" | "unknown";
  shipping: "included" | "excluded" | "unknown";
  tax: "included" | "excluded" | "unknown";
  observedAt: string;
  expiresAt: string;
  usage: Readonly<{ ai: boolean; priceComparison: boolean; store: false }>;
  notices: readonly string[];
}>;
export type CommercePage = Readonly<{
  listings: readonly CommerceListing[];
  total: number | null;
  page: number;
  limit: number;
  furusato?: FurusatoComparison;
}>;
export type CommerceProvider = Readonly<{
  source: CommerceSource;
  request: (
    input: CommerceInput,
    signal?: AbortSignal,
  ) => Promise<Result<CommercePage, CommerceError>>;
}>;

const sourceNames = Object.freeze({
  rakuten: "楽天市場",
  yahoo: "Yahoo!ショッピング",
  amazon: "Amazon",
  rakuten_furusato: "楽天ふるさと納税",
  satofull: "さとふる",
});

function isCommerceSource(input: unknown): input is CommerceSource {
  return (
    input === "rakuten" ||
    input === "yahoo" ||
    input === "amazon" ||
    input === "rakuten_furusato" ||
    input === "satofull"
  );
}

function parseCommerceInput(input: unknown): Result<CommerceInput, CommerceError> {
  if (
    !record(input) ||
    !isCommerceSource(input["source"]) ||
    (input["operation"] !== "search" && input["operation"] !== "lookup") ||
    typeof input["query"] !== "string" ||
    input["query"].trim().length === 0 ||
    /\p{Cc}/u.test(input["query"]) ||
    new TextEncoder().encode(input["query"]).length > (input["operation"] === "lookup" ? 2048 : 128)
  ) {
    return err({ code: "invalid_request" });
  }
  const page = input["page"] ?? 1;
  const limit = input["limit"] ?? 10;
  if (
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    (input["operation"] === "lookup" && (page !== 1 || limit !== 10))
  ) {
    return err({ code: "invalid_request" });
  }
  return ok(
    Object.freeze({
      source: input["source"],
      operation: input["operation"],
      query: input["query"].trim(),
      page,
      limit,
    }),
  );
}

export function createCommerceService(
  providers: readonly CommerceProvider[],
  options: Readonly<{ score?: FurusatoOverallScoring; clock?: () => number }> = {},
): Readonly<{
  sources: () => ReadonlyArray<
    Readonly<{ id: CommerceSource; label: string; configured: boolean }>
  >;
  request: (input: unknown, signal?: AbortSignal) => Promise<Result<CommercePage, CommerceError>>;
  compareFurusato: (
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<Result<CommercePage, CommerceError>>;
}> {
  if (new Set(providers.map((provider) => provider.source)).size !== providers.length) {
    throw new Error("Duplicate commerce source");
  }
  async function request(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<Result<CommercePage, CommerceError>> {
    const parsed = parseCommerceInput(raw);
    if (parsed.tag === "err") {
      return parsed;
    }
    const provider = providers.find((entry) => entry.source === parsed.value.source);
    if (provider === undefined) {
      return err({ code: "not_configured" });
    }
    try {
      signal?.throwIfAborted();
      const response = await provider.request(parsed.value, signal);
      signal?.throwIfAborted();
      if (response.tag === "err") {
        return response;
      }
      return ok(
        Object.freeze({
          ...response.value,
          ...(provider.source === "rakuten_furusato" || provider.source === "satofull"
            ? { furusato: compareFurusatoListings(response.value.listings) }
            : {}),
        }),
      );
    } catch {
      return err({ code: "provider_unavailable" });
    }
  }
  return Object.freeze({
    sources: () =>
      Object.freeze(
        Object.entries(sourceNames).flatMap(([id, label]) =>
          isCommerceSource(id)
            ? [
                Object.freeze({
                  id,
                  label,
                  configured: providers.some((provider) => provider.source === id),
                }),
              ]
            : [],
        ),
      ),
    request,
    async compareFurusato(raw, signal) {
      if (
        !record(raw) ||
        !Array.isArray(raw["items"]) ||
        raw["items"].length < 2 ||
        raw["items"].length > 6
      ) {
        return err({ code: "invalid_request" });
      }
      const inputs: unknown[] = raw["items"];
      const parsed = inputs.map((item) =>
        record(item) && (item["source"] === "rakuten_furusato" || item["source"] === "satofull")
          ? parseCommerceInput({
              source: item["source"],
              query: item["query"],
              operation: "lookup",
            })
          : err<CommerceError>({ code: "invalid_request" }),
      );
      // Validate the entire batch before any network request.
      if (parsed.some((item) => item.tag === "err")) {
        return err({ code: "invalid_request" });
      }
      const keys = new Set<string>();
      for (const item of parsed) {
        if (item.tag === "err") {
          return item;
        }
        const key = `${item.value.source}:${item.value.query}`;
        if (keys.has(key)) {
          return err({ code: "invalid_request" });
        }
        keys.add(key);
        if (
          item.value.source === "satofull" &&
          (item.value.query.length > 300 || /[\s/?#]/u.test(item.value.query))
        ) {
          return err({ code: "invalid_request" });
        }
        if (item.value.source === "rakuten_furusato") {
          try {
            const url = new URL(item.value.query);
            if (
              url.protocol !== "https:" ||
              url.hostname !== "item.rakuten.co.jp" ||
              url.username !== "" ||
              url.password !== "" ||
              (url.port !== "" && url.port !== "443") ||
              !/^\/[^/]+\/[^/]+\/?$/u.test(url.pathname)
            ) {
              return err({ code: "invalid_request" });
            }
          } catch {
            return err({ code: "invalid_request" });
          }
        }
        if (!providers.some((provider) => provider.source === item.value.source)) {
          return err({ code: "not_configured" });
        }
      }
      const listings: CommerceListing[] = [];
      const deadline = AbortSignal.timeout(25_000);
      const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      for (const input of parsed) {
        if (input.tag === "err") {
          return input;
        }
        const response = await request(input.value, cancellation);
        if (response.tag === "err") {
          return response;
        }
        if (response.value.listings.length !== 1) {
          return err({ code: "listing_not_found" });
        }
        listings.push(...response.value.listings);
      }
      if (new Set(listings.map((item) => `${item.source}:${item.id}`)).size !== listings.length) {
        return err({ code: "invalid_request" });
      }
      const comparison = compareFurusatoListings(listings);
      try {
        const scoring = await scoreFurusatoListings(
          listings,
          comparison,
          options.score,
          options.clock ?? Date.now,
          cancellation,
        );
        cancellation.throwIfAborted();
        return ok(
          Object.freeze({
            listings: Object.freeze(listings),
            total: listings.length,
            page: 1,
            limit: listings.length,
            furusato: { ...comparison, scoring },
          }),
        );
      } catch {
        return err({ code: "provider_unavailable" });
      }
    },
  });
}
