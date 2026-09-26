import { err, map, ok, sequence } from "./comparison/algebra.js";
import type { Result } from "./comparison/algebra.js";
import { productsSchema, readIdentified, readListing, readProduct } from "./comparison/catalog.js";
import { investigateProduct } from "./comparison/investigate.js";
import type { InvestigationError } from "./comparison/investigate.js";
import { readReference } from "./comparison/providers.js";
import { factSchema, rankProducts } from "./comparison/ranking.js";
import type {
  Candidate,
  Ranking,
  RankingError,
  RankingPolicy,
  Requirement,
} from "./comparison/ranking.js";
import { instant, permissions, valueOf } from "./comparison/values.js";
import type { Instant } from "./comparison/values.js";
import { createAuroraRunStore } from "./infrastructure/aws/aurora.js";
import type { RunStore } from "./infrastructure/aws/aurora.js";
import { apiResponse, parseApiRequest } from "./infrastructure/http/request.js";
import type { ApiResponse } from "./infrastructure/http/request.js";
import { createJevJudge } from "./providers/jev/index.js";
import { rakutenProvider } from "./providers/rakuten/index.js";

export function createApiHandler(
  configuration: Readonly<{ resourceArn: string; secretArn: string; database: string }> | null,
): (event: unknown) => Promise<ApiResponse> {
  const store: RunStore | null =
    configuration === null
      ? null
      : createAuroraRunStore(
          configuration.resourceArn,
          configuration.secretArn,
          configuration.database,
        );
  return async (event) => {
    try {
      const request = parseApiRequest(event);
      if (request.tag === "err") {
        return apiResponse(400, request);
      }
      const { path, method, url } = request.value;
      if (path === "/api/health" && method === "GET") {
        return apiResponse(200, { status: "ok", mode: "demo" });
      }
      if (path !== "/api/investigate") {
        return apiResponse(404, err({ code: "not_found" }));
      }
      if (method !== "GET" && method !== "POST") {
        return apiResponse(405, err({ code: "method_not_allowed" }));
      }
      if (url === null) {
        return apiResponse(400, err({ code: "invalid_url" }));
      }
      const result = await investigateDemo(url);
      if (method === "POST" && store !== null) {
        const saved = await store(result.tag === "ok" ? "succeeded" : "failed");
        if (saved.tag === "err") {
          return apiResponse(503, saved);
        }
      }
      return apiResponse(result.tag === "ok" ? 200 : 422, result);
    } catch {
      return apiResponse(500, err({ code: "internal_error" }));
    }
  };
}

async function rankWithJev(
  candidates: readonly Candidate[],
  requirements: readonly Requirement[],
  preferences: string,
  policy: RankingPolicy,
  apiKey: string,
  model: string,
  now: Instant,
): Promise<Result<Ranking, RankingError>> {
  return await rankProducts(
    candidates,
    requirements,
    preferences,
    policy,
    createJevJudge(apiKey, model),
    now,
  );
}

const demoRankingPolicy = {
  version: "usb-c-charger-demo-v1",
  category: "usb-c-wall-charger",
  mode: "overall",
  tieMargin: 0.05,
  minimumConfidence: 0.7,
  criteria: [
    {
      id: "device_fit",
      weight: 3,
      factKeys: ["powerW"],
      instructions:
        "Rate verified USB-C PD power against the user's stated device requirement. Do not assume sustained performance.",
      levels: [
        "Cannot meet need",
        "Far below need",
        "Partly meets need",
        "Meets need",
        "Meets need with useful headroom",
      ],
    },
    {
      id: "port_fit",
      weight: 1,
      factKeys: ["usbCPorts"],
      instructions: "Rate verified USB-C port count against the user's simultaneous charging need.",
      levels: [
        "Cannot meet need",
        "Far below need",
        "Partly meets need",
        "Meets need",
        "Exceeds need usefully",
      ],
    },
  ],
} as const satisfies RankingPolicy;

export async function rankDemoWithJev(
  apiKey: string,
  model: string,
): Promise<
  Result<
    Readonly<{
      mode: "demo";
      notice: string;
      policyVersion: string;
      ranked: ReadonlyArray<
        Readonly<{ productId: string; rank: number; internalIndex: number; model: string }>
      >;
    }>,
    RankingError
  >
> {
  const now = systemTime();
  const observedAt = valueOf(now);
  const expiresAt = new Date(Date.parse(observedAt) + 3_600_000).toISOString();
  const rights = {
    fetch: { status: "granted", expiresAt },
    display: { status: "granted", expiresAt },
    store: { status: "denied" },
    ai: { status: "granted", expiresAt },
    affiliate: { status: "denied" },
  };
  const fixtures = [
    { id: "demo-65w", powerW: 65, usbCPorts: 2 },
    { id: "demo-100w", powerW: 100, usbCPorts: 2 },
  ] as const;
  const raw = fixtures.map(({ id }) => ({
    productId: id,
    identity: {
      manufacturer: "DEMO",
      model: id,
      gtin: null,
      variant: { status: "confirmed", color: null, capacity: null, packCount: 1 },
    },
    evidence: { provider: "demo", source: `https://example.com/${id}`, observedAt },
    permissions: rights,
  }));
  const products = productsSchema.parse(raw);
  if (products.tag === "err") {
    return err({ code: "invalid_request" });
  }
  const candidates = sequence(
    products.value.map((product) => {
      const id = valueOf(readProduct(product).id);
      const fixture = fixtures.find((item) => item.id === id);
      if (fixture === undefined) {
        return err({ code: "invalid_request" as const });
      }
      const facts = sequence([
        factSchema.parse({
          productId: id,
          key: "powerW",
          value: fixture.powerW,
          evidence: { provider: "demo", source: `https://example.com/${id}`, observedAt },
          permissions: rights,
        }),
        factSchema.parse({
          productId: id,
          key: "usbCPorts",
          value: fixture.usbCPorts,
          evidence: { provider: "demo", source: `https://example.com/${id}`, observedAt },
          permissions: rights,
        }),
      ]);
      return facts.tag === "ok"
        ? ok(Object.freeze({ product, facts: facts.value }))
        : err({ code: "invalid_request" as const });
    }),
  );
  if (candidates.tag === "err") {
    return candidates;
  }
  return map(
    await rankWithJev(
      candidates.value,
      [
        { key: "powerW", comparison: "at_least", value: 65 },
        { key: "usbCPorts", comparison: "at_least", value: 2 },
      ],
      "One USB-C PD laptop requiring 65W; two USB-C devices charged together",
      demoRankingPolicy,
      apiKey,
      model,
      now,
    ),
    (result) =>
      Object.freeze({
        mode: "demo",
        notice:
          "Artificial products and uncalibrated internal index. Not a public suitability percentage.",
        policyVersion: result.policyVersion,
        ranked: Object.freeze(
          result.ranked.map((entry) =>
            Object.freeze({
              productId: valueOf(readProduct(entry.product).id),
              rank: entry.rank,
              internalIndex: entry.index,
              model: entry.model,
            }),
          ),
        ),
      }),
  );
}

type DemoInvestigation = Readonly<{
  mode: "demo";
  notice: string;
  provider: string;
  listingId: string;
  productId: string;
  title: string;
  canonicalUrl: string;
  matchMethod: string;
  observedAt: string;
}>;

function systemTime(): Instant {
  const result = instant(new Date().toISOString());
  if (result.tag === "err") {
    throw new Error("System clock did not produce a valid instant");
  }
  return result.value;
}

// Artificial records only. No requests are sent to Rakuten or an affiliate service.
export async function investigateDemo(
  input: string,
): Promise<Result<DemoInvestigation, InvestigationError>> {
  const observedAt = valueOf(systemTime());
  const rawPermissions = {
    fetch: {
      status: "granted",
      expiresAt: new Date(Date.parse(observedAt) + 3_600_000).toISOString(),
    },
    display: {
      status: "granted",
      expiresAt: new Date(Date.parse(observedAt) + 3_600_000).toISOString(),
    },
    store: { status: "denied" },
    ai: { status: "denied" },
    affiliate: { status: "denied" },
  };
  const rights = permissions(rawPermissions);
  if (rights.tag === "err") {
    return rights;
  }
  const evidence = {
    provider: "rakuten",
    source: "https://item.rakuten.co.jp/demo-shop/demo-product/",
    observedAt,
  };
  const identity = {
    manufacturer: "DEMO manufacturer",
    model: "DEMO-001",
    gtin: null,
    variant: { status: "confirmed", color: "black", capacity: null, packCount: 1 },
  };
  const provider = rakutenProvider({
    mode: "demo",
    permissions: () => rights.value,
    fetchListing: (reference) =>
      Promise.resolve(
        valueOf(readReference(reference).id) === "demo-shop:demo-product"
          ? ok({
              listingId: "demo-shop:demo-product",
              title: "Artificial demo product",
              identity,
              evidence,
              permissions: rawPermissions,
              offer: null,
            })
          : err({ code: "listing_not_found" }),
      ),
    searchProducts: () =>
      Promise.resolve(
        ok([{ productId: "demo-product-001", identity, evidence, permissions: rawPermissions }]),
      ),
  });
  if (provider.tag === "err") {
    return provider;
  }
  return map(await investigateProduct(input, [provider.value], systemTime), (result) => {
    const identified = readIdentified(result.identified);
    const listing = readListing(identified.listing);
    return Object.freeze({
      mode: "demo",
      notice: "Artificial local data; no live product lookup or affiliate integration.",
      provider: valueOf(listing.evidence.provider),
      listingId: valueOf(listing.id),
      productId: valueOf(readProduct(identified.product).id),
      title: listing.title,
      canonicalUrl: valueOf(readReference(result.reference).canonicalUrl),
      matchMethod: identified.match.method,
      observedAt: valueOf(listing.evidence.observedAt),
    });
  });
}
