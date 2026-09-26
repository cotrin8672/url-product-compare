import assert from "node:assert/strict";
import { test } from "node:test";

import {
  affiliateLinkSchema,
  readAffiliateLink,
  readVerifiedLink,
  resolveAffiliateLink,
  selectAffiliateProvider,
} from "../../comparison/affiliate.js";
import type { AffiliateProvider } from "../../comparison/affiliate.js";
import {
  andThen,
  andThenOption,
  err,
  map,
  mapOption,
  none,
  ok,
  sequence,
  some,
} from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import {
  identifyProduct,
  listingSchema,
  productsSchema,
  readIdentified,
  readListing,
  readProduct,
} from "../../comparison/catalog.js";
import { investigateProduct } from "../../comparison/investigate.js";
import { comparePrices, offerSchema, readOffer } from "../../comparison/offer.js";
import { readReference, referenceSchema } from "../../comparison/providers.js";
import type { ProductDataProvider } from "../../comparison/providers.js";
import {
  instant,
  permissions,
  providerId,
  sameProductId,
  valueOf,
} from "../../comparison/values.js";

function unwrap<T, E>(value: Result<T, E>): T {
  assert.equal(value.tag, "ok");
  return value.value;
}
function failure<T, E extends Readonly<{ code: string }>>(
  value: Result<T, E>,
  code: E["code"],
): void {
  assert.equal(value.tag, "err");
  assert.equal(value.error.code, code);
}
const observedAt = "2026-09-26T00:00:00.000Z";
const expiresAt = "2026-09-27T00:00:00.000Z";
const clock = (): ReturnType<
  typeof unwrap<ReturnType<typeof instant> extends Result<infer T, unknown> ? T : never, unknown>
> => unwrap(instant("2026-09-26T01:00:00.000Z"));
const rawPermissions = Object.freeze({
  fetch: { status: "granted", expiresAt },
  display: { status: "granted", expiresAt },
  store: { status: "denied" },
  ai: { status: "denied" },
  affiliate: { status: "granted", expiresAt },
});
const grants = unwrap(permissions(rawPermissions));
const variant = Object.freeze({
  status: "confirmed",
  color: "black",
  capacity: null,
  packCount: 1,
});
const identity = Object.freeze({
  manufacturer: "Example",
  model: "A-1",
  gtin: "4901234567894",
  variant,
});
const url = "https://alpha.example/items/a";
const evidence = Object.freeze({ provider: "alpha", source: url, observedAt });
const rawListing = Object.freeze({
  listingId: "a",
  title: "Demo A",
  identity,
  evidence,
  permissions: rawPermissions,
  offer: null,
});
const rawProduct = Object.freeze({
  productId: "a",
  identity,
  evidence,
  permissions: rawPermissions,
});
const rawOffer = Object.freeze({
  listingId: "a",
  variant,
  price: { currency: "JPY", minorUnits: 1000 },
  shipping: { currency: "JPY", minorUnits: 0 },
  tax: "included",
  stock: "in_stock",
  condition: "new",
  destination: "JP-13",
  eligibility: "public",
  quantity: 1,
  evidence,
  expiresAt,
});

function source(
  name = "alpha",
  listing: unknown = rawListing,
  products: unknown = [rawProduct],
): ProductDataProvider {
  const id = unwrap(providerId(name));
  return Object.freeze({
    id,
    mode: "demo",
    permissions: () => grants,
    parseUrl: (input) =>
      new URL(valueOf(input)).hostname === `${name}.example`
        ? map(
            referenceSchema.parse({
              provider: name,
              listingId: "a",
              canonicalUrl: `https://${name}.example/items/a`,
            }),
            some,
          )
        : ok(none),
    fetchListing: () => Promise.resolve(listingSchema.parse(listing)),
    searchProducts: () => Promise.resolve(productsSchema.parse(products)),
  });
}

function affiliate(raw: unknown = rawLink): AffiliateProvider {
  return Object.freeze({
    id: unwrap(providerId("network")),
    permissions: () => grants,
    trackingHosts: Object.freeze(["track.example"]),
    resolveLink: () => Promise.resolve(map(affiliateLinkSchema.parse(raw), some)),
    verifyDestination: (link) =>
      Promise.resolve(ok(new URL(valueOf(readAffiliateLink(link).url)).pathname === "/click/a")),
  });
}
const rawLink = Object.freeze({
  provider: "network",
  catalogProvider: "alpha",
  productId: "a",
  listingId: "a",
  variant,
  url: "https://track.example/click/a",
  destination: url,
  expiresAt,
  kind: "purchase_offer",
});

await test("Result and Option compose and short-circuit without effects", () => {
  const double = (value: number): number => value * 2;
  assert.deepEqual(map(ok(2), double), ok(4));
  assert.deepEqual(map(err("failure"), double), err("failure"));
  assert.deepEqual(
    andThen(ok(2), (value) => ok(double(value))),
    ok(4),
  );
  assert.deepEqual(
    andThen(err("failure"), () => {
      throw new Error("must not run");
    }),
    err("failure"),
  );
  assert.deepEqual(mapOption(none, double), none);
  assert.deepEqual(mapOption(some(2), double), some(4));
  assert.deepEqual(
    andThenOption(some(2), (value) => some(double(value))),
    some(4),
  );
  assert.deepEqual(
    andThenOption(none, () => {
      throw new Error("must not run");
    }),
    none,
  );
  assert.deepEqual(sequence([ok(1), ok(2)]), ok([1, 2]));
  assert.deepEqual(sequence([ok(1), err("failure")]), err("failure"));
  assert.deepEqual(sequence([]), ok([]));
});

await test("two registered providers route without core changes; same local product IDs remain distinct", async () => {
  const betaEvidence = { ...evidence, provider: "beta", source: "https://beta.example/items/a" };
  const providers = [
    source(),
    source("beta", { ...rawListing, evidence: betaEvidence }, [
      { ...rawProduct, evidence: betaEvidence },
    ]),
  ];
  const alpha = unwrap(await investigateProduct(url, providers, clock));
  const beta = unwrap(await investigateProduct(betaEvidence.source, providers, clock));
  assert.equal(alpha.mode, "demo");
  assert.equal(readIdentified(alpha.identified).match.method, "gtin");
  assert.equal(
    sameProductId(
      readProduct(readIdentified(alpha.identified).product).id,
      readProduct(readIdentified(beta.identified).product).id,
    ),
    false,
  );
  assert.ok(Object.isFrozen(readListing(readIdentified(alpha.identified).listing).identity));
});

await test("URL guards reject credentials, unregistered hosts and ambiguous registries before effects", async () => {
  const forbidden = (): never => {
    throw new Error("must not call");
  };
  const provider = { ...source(), fetchListing: forbidden, searchProducts: forbidden };
  for (const value of [
    "bad",
    "http://alpha.example/items/a",
    "https://user:secret@alpha.example/items/a",
    "https://alpha.example:444/items/a",
    `${url}#secret`,
    "https://127.0.0.1/items/a",
  ]) {
    failure(await investigateProduct(value, [provider], clock), "invalid_url");
  }
  failure(
    await investigateProduct("https://other.example/items/a", [provider], clock),
    "unsupported_url",
  );
  failure(await investigateProduct(url, [provider, provider], clock), "ambiguous_provider");
  failure(
    await investigateProduct(
      url,
      [provider, { ...provider, id: unwrap(providerId("other")) }],
      clock,
    ),
    "ambiguous_provider",
  );
});

await test("schemas preserve missing vs zero price, reject malformed GTIN, timestamps, variants and offer targets", () => {
  for (const raw of [
    null,
    [],
    {},
    { ...rawListing, identity: { ...identity, gtin: "4901234567890" } },
    { ...rawListing, evidence: { ...evidence, observedAt: "2026-02-30T00:00:00.000Z" } },
    { ...rawListing, identity: { ...identity, variant: { ...variant, color: undefined } } },
    { ...rawListing, identity: { ...identity, variant: "black" } },
    { ...rawListing, offer: { ...rawOffer, listingId: "other" } },
    { ...rawListing, offer: { ...rawOffer, variant: { ...variant, color: "white" } } },
  ]) {
    failure(listingSchema.parse(raw), "invalid_data");
  }
  for (const price of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "100"]) {
    failure(
      offerSchema.parse({ ...rawOffer, price: { currency: "JPY", minorUnits: price } }),
      "invalid_data",
    );
  }
  assert.deepEqual(readOffer(unwrap(offerSchema.parse({ ...rawOffer, price: null }))).price, none);
  assert.deepEqual(
    readOffer(unwrap(offerSchema.parse({ ...rawOffer, price: { currency: "JPY", minorUnits: 0 } })))
      .price,
    some({ currency: "JPY", minorUnits: 0 }),
  );
  failure(productsSchema.parse({ products: [] }), "invalid_data");
});

await test("identity rejects absent, ambiguous, unknown variants and conflicting evidence", async () => {
  failure(
    await investigateProduct(url, [source("alpha", rawListing, [])], clock),
    "product_not_found",
  );
  failure(
    await investigateProduct(
      url,
      [source("alpha", rawListing, [rawProduct, { ...rawProduct, productId: "b" }])],
      clock,
    ),
    "ambiguous_product",
  );
  for (const other of [
    { ...identity, model: "B" },
    { ...identity, manufacturer: "Other" },
    { ...identity, gtin: "4006381333931" },
    { ...identity, variant: { ...variant, color: "white" } },
  ]) {
    failure(
      await investigateProduct(
        url,
        [source("alpha", rawListing, [{ ...rawProduct, identity: other }])],
        clock,
      ),
      "conflicting_identity",
    );
  }
  failure(
    await investigateProduct(
      url,
      [
        source("alpha", {
          ...rawListing,
          identity: { ...identity, variant: { status: "unknown" } },
        }),
      ],
      clock,
    ),
    "insufficient_identity",
  );
  failure(
    await investigateProduct(
      url,
      [source("alpha", { ...rawListing, identity: { variant } })],
      clock,
    ),
    "insufficient_identity",
  );
  for (const pair of [
    [{ ...identity, gtin: null }, identity],
    [identity, { ...identity, gtin: null }],
  ]) {
    const [left, right] = pair;
    const result = unwrap(
      await investigateProduct(
        url,
        [source("alpha", { ...rawListing, identity: left }, [{ ...rawProduct, identity: right }])],
        clock,
      ),
    );
    assert.equal(readIdentified(result.identified).match.method, "manufacturer_model_variant");
  }
  failure(
    await investigateProduct(
      url,
      [
        source("alpha", rawListing, [
          { ...rawProduct, identity: { ...identity, gtin: null, model: "B" } },
        ]),
      ],
      clock,
    ),
    "product_not_found",
  );
});

await test("namespaces and canonical listing target are checked before search", async () => {
  const noSearch = (): never => {
    throw new Error("must not search");
  };
  for (const listing of [
    { ...rawListing, listingId: "wrong" },
    { ...rawListing, evidence: { ...evidence, provider: "beta" } },
    { ...rawListing, evidence: { ...evidence, source: "https://alpha.example/items/b" } },
  ]) {
    failure(
      await investigateProduct(
        url,
        [{ ...source("alpha", listing), searchProducts: noSearch }],
        clock,
      ),
      "listing_mismatch",
    );
  }
  failure(
    await investigateProduct(
      url,
      [
        source("alpha", rawListing, [
          { ...rawProduct, evidence: { ...evidence, provider: "beta" } },
        ]),
      ],
      clock,
    ),
    "provider_mismatch",
  );
  failure(
    await investigateProduct(url, [{ ...source(), id: unwrap(providerId("other")) }], clock),
    "provider_mismatch",
  );
});

await test("fetch and display permissions gate effects independently; expiry after await stops search", async () => {
  for (const operation of ["fetch", "display"]) {
    const blocked = unwrap(permissions({ ...rawPermissions, [operation]: { status: "denied" } }));
    failure(
      await investigateProduct(
        url,
        [
          {
            ...source(),
            permissions: () => blocked,
            fetchListing: () => {
              throw new Error("must not fetch");
            },
          },
        ],
        clock,
      ),
      "source_not_authorized",
    );
  }
  const expiredClock = (): ReturnType<typeof clock> => unwrap(instant("2026-09-28T00:00:00.000Z"));
  failure(await investigateProduct(url, [source()], expiredClock), "source_not_authorized");
  let calls = 0;
  const advancingClock = (): ReturnType<typeof clock> => (++calls === 1 ? clock() : expiredClock());
  failure(
    await investigateProduct(
      url,
      [
        {
          ...source(),
          searchProducts: () => {
            throw new Error("must not search");
          },
        },
      ],
      advancingClock,
    ),
    "source_not_authorized",
  );
  failure(
    await investigateProduct(
      url,
      [
        source("alpha", {
          ...rawListing,
          permissions: { ...rawPermissions, display: { status: "denied" } },
        }),
      ],
      clock,
    ),
    "source_not_authorized",
  );
  let listingClockReads = 0;
  const listingClock = (): ReturnType<typeof clock> =>
    ++listingClockReads < 3 ? clock() : unwrap(instant("2026-09-26T03:00:00.000Z"));
  const listingExpires = {
    ...rawListing,
    permissions: {
      ...rawPermissions,
      display: { status: "granted", expiresAt: "2026-09-26T02:00:00.000Z" },
    },
  };
  failure(
    await investigateProduct(url, [source("alpha", listingExpires)], listingClock),
    "source_not_authorized",
  );
  assert.equal(unwrap(await investigateProduct(url, [source()], clock)).mode, "demo");
});

await test("observation time uses refreshed clock; future evidence and raw exceptions are rejected", async () => {
  const laterEvidence = { ...evidence, observedAt: "2026-09-26T02:00:00.000Z" };
  let calls = 0;
  const advancing = (): ReturnType<typeof clock> =>
    ++calls === 1 ? clock() : unwrap(instant("2026-09-26T03:00:00.000Z"));
  assert.equal(
    (
      await investigateProduct(
        url,
        [
          source("alpha", { ...rawListing, evidence: laterEvidence }, [
            { ...rawProduct, evidence: laterEvidence },
          ]),
        ],
        advancing,
      )
    ).tag,
    "ok",
  );
  failure(
    await investigateProduct(
      url,
      [source("alpha", { ...rawListing, evidence: laterEvidence })],
      clock,
    ),
    "future_evidence",
  );
  for (const provider of [
    {
      ...source(),
      parseUrl: () => {
        throw new Error("secret");
      },
    },
    {
      ...source(),
      permissions: () => {
        throw new Error("secret");
      },
    },
    { ...source(), fetchListing: () => Promise.reject(new Error("secret")) },
    { ...source(), searchProducts: () => Promise.reject(new Error("secret")) },
  ]) {
    const result = await investigateProduct(url, [provider], clock);
    failure(result, "provider_unavailable");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  failure(
    await investigateProduct(
      url,
      [{ ...source(), fetchListing: () => Promise.resolve(err({ code: "listing_not_found" })) }],
      clock,
    ),
    "listing_not_found",
  );
});

await test("price comparison rejects incomplete, stale, incompatible, nonpublic and overflow amounts", () => {
  const offer = unwrap(offerSchema.parse(rawOffer));
  assert.deepEqual(comparePrices(offer, offer, clock()), ok(0));
  assert.deepEqual(
    comparePrices(
      offer,
      unwrap(offerSchema.parse({ ...rawOffer, price: { currency: "JPY", minorUnits: 2000 } })),
      clock(),
    ),
    ok(-1),
  );
  for (const patch of [
    { price: null },
    { shipping: null },
    { stock: undefined },
    { stock: "out_of_stock" },
    { tax: "excluded" },
    { eligibility: "members" },
    { destination: "JP-27" },
    { quantity: 2 },
    { variant: { ...variant, packCount: 2 } },
    { condition: "used" },
    { expiresAt: "2026-09-26T00:30:00.000Z" },
    { evidence: { ...evidence, observedAt: "2026-09-26T02:00:00.000Z" } },
    { price: { currency: "USD", minorUnits: 100 }, shipping: { currency: "USD", minorUnits: 0 } },
    {
      price: { currency: "JPY", minorUnits: Number.MAX_SAFE_INTEGER },
      shipping: { currency: "JPY", minorUnits: 1 },
    },
  ]) {
    failure(
      comparePrices(offer, unwrap(offerSchema.parse({ ...rawOffer, ...patch })), clock()),
      "price_not_comparable",
    );
  }
  failure(offerSchema.parse({ ...rawOffer, stock: "yes" }), "invalid_data");
  failure(
    offerSchema.parse({ ...rawOffer, shipping: { currency: "USD", minorUnits: 1 } }),
    "invalid_data",
  );
  failure(offerSchema.parse({ ...rawOffer, expiresAt: observedAt }), "invalid_data");
});

await test("independent affiliate provider verifies exact product, listing, variant, URL and expiry", async () => {
  const identified = unwrap(await investigateProduct(url, [source()], clock)).identified;
  const linked = unwrap(await resolveAffiliateLink(identified, affiliate(), clock));
  assert.equal(linked.tag, "some");
  assert.equal(valueOf(readVerifiedLink(linked.value).url), rawLink.url);
  assert.equal(readVerifiedLink(linked.value).kind, "purchase_offer");
  for (const patch of [
    { productId: "wrong" },
    { listingId: "wrong" },
    { provider: "other" },
    { catalogProvider: "beta" },
    { destination: "https://alpha.example/items/wrong" },
    { variant: { ...variant, color: "white" } },
  ]) {
    failure(
      await resolveAffiliateLink(identified, affiliate({ ...rawLink, ...patch }), clock),
      "affiliate_target_mismatch",
    );
  }
  failure(
    await resolveAffiliateLink(
      identified,
      affiliate({ ...rawLink, url: "https://evil.example/click" }),
      clock,
    ),
    "unsafe_affiliate_link",
  );
  failure(
    await resolveAffiliateLink(identified, affiliate({ ...rawLink, expiresAt: observedAt }), clock),
    "affiliate_link_expired",
  );
  failure(
    await resolveAffiliateLink(
      identified,
      affiliate({ ...rawLink, url: "javascript:alert(1)" }),
      clock,
    ),
    "invalid_data",
  );
  assert.deepEqual(
    await resolveAffiliateLink(
      identified,
      { ...affiliate(), resolveLink: () => Promise.resolve(ok(none)) },
      clock,
    ),
    ok(none),
  );
  failure(
    await resolveAffiliateLink(
      identified,
      { ...affiliate(), verifyDestination: () => Promise.resolve(ok(false)) },
      clock,
    ),
    "affiliate_target_mismatch",
  );
  failure(
    await resolveAffiliateLink(
      identified,
      affiliate({ ...rawLink, url: "https://track.example/click/wrong" }),
      clock,
    ),
    "affiliate_target_mismatch",
  );
});

await test("affiliate registry selects a second service without changing product logic", async () => {
  const identified = unwrap(await investigateProduct(url, [source()], clock)).identified;
  const secondId = unwrap(providerId("second-network"));
  const secondLink = {
    ...rawLink,
    provider: "second-network",
    url: "https://second.example/click/a",
  };
  const second: AffiliateProvider = Object.freeze({
    ...affiliate(),
    id: secondId,
    trackingHosts: Object.freeze(["second.example"]),
    resolveLink: () => Promise.resolve(map(affiliateLinkSchema.parse(secondLink), some)),
  });
  const selected = unwrap(selectAffiliateProvider(secondId, [affiliate(), second]));
  const linked = unwrap(await resolveAffiliateLink(identified, selected, clock));
  assert.equal(linked.tag, "some");
  assert.equal(valueOf(readVerifiedLink(linked.value).url), secondLink.url);
  failure(selectAffiliateProvider(secondId, [second, second]), "ambiguous_affiliate_provider");
  failure(
    selectAffiliateProvider(unwrap(providerId("missing")), [second]),
    "affiliate_provider_not_found",
  );
});

await test("affiliate permission does not alter identity eligibility; denied/revoked link permissions stop effects", async () => {
  const deniedRights = { ...rawPermissions, affiliate: { status: "denied" } };
  const identified = unwrap(
    await investigateProduct(
      url,
      [source("alpha", { ...rawListing, permissions: deniedRights })],
      clock,
    ),
  ).identified;
  failure(
    await resolveAffiliateLink(
      identified,
      {
        ...affiliate(),
        resolveLink: () => {
          throw new Error("must not call");
        },
      },
      clock,
    ),
    "affiliate_not_authorized",
  );
  const good = unwrap(await investigateProduct(url, [source()], clock)).identified;
  failure(
    await resolveAffiliateLink(
      good,
      {
        ...affiliate(),
        permissions: () => unwrap(permissions(deniedRights)),
        resolveLink: () => {
          throw new Error("must not call");
        },
      },
      clock,
    ),
    "affiliate_not_authorized",
  );
  const rejected = await resolveAffiliateLink(
    good,
    { ...affiliate(), resolveLink: () => Promise.reject(new Error("secret")) },
    clock,
  );
  failure(rejected, "provider_unavailable");
  assert.equal(JSON.stringify(rejected).includes("secret"), false);
});

await test("private payloads prevent spread replacement of validated identity, money, time and references", async () => {
  const listing = unwrap(listingSchema.parse(rawListing));
  const products = unwrap(productsSchema.parse([rawProduct]));
  const forgedListing = { ...listing, identity: { model: "fake" } };
  const identified = unwrap(identifyProduct(forgedListing, products));
  assert.equal(readIdentified(identified).match.method, "gtin");
  const offer = unwrap(offerSchema.parse(rawOffer));
  const forgedOffer = { ...offer, price: 0 };
  const forgedInstant = { ...clock(), value: "garbage" };
  assert.deepEqual(comparePrices(forgedOffer, offer, forgedInstant), ok(0));
  const result = unwrap(await investigateProduct(url, [source()], clock));
  const forgedReference = { ...result.reference, listingId: "fake" };
  assert.equal(valueOf(readReference(forgedReference).id), "a");
});
