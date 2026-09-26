import { andThen, err, map, ok, sequence } from "./algebra.js";
import type { Option, Result } from "./algebra.js";
import { offerSchema, readOffer } from "./offer.js";
import type { Offer } from "./offer.js";
import {
  evidence,
  listingId,
  optional,
  permissions,
  productId,
  record,
  sameListingId,
  text,
} from "./values.js";
import type { Evidence, ListingId, Permissions, ProductId, Schema, SchemaError } from "./values.js";

const listingData = Symbol("listingData");
const productData = Symbol("productData");
const identifiedData = Symbol("identifiedData");
export type Variant =
  | Readonly<{ status: "unknown" }>
  | Readonly<{
      status: "confirmed";
      color: Option<string>;
      capacity: Option<Readonly<{ value: number; unit: "ml" | "GB" | "mAh" }>>;
      packCount: number;
    }>;
export type Identity = Readonly<{
  manufacturer: Option<string>;
  model: Option<string>;
  gtin: Option<string>;
  variant: Variant;
}>;
type ListingData = Readonly<{
  id: ListingId;
  title: string;
  identity: Identity;
  evidence: Evidence;
  permissions: Permissions;
  offer: Option<Offer>;
}>;
type ProductData = Readonly<{
  id: ProductId;
  identity: Identity;
  evidence: Evidence;
  permissions: Permissions;
}>;
export type Listing = Readonly<{ [listingData]: ListingData }>;
export type Product = Readonly<{ [productData]: ProductData }>;
type MatchEvidence = Readonly<{
  method: "gtin" | "manufacturer_model_variant";
  listing: Evidence;
  product: Evidence;
}>;
export type IdentifiedProduct = Readonly<{
  [identifiedData]: Readonly<{ listing: Listing; product: Product; match: MatchEvidence }>;
}>;

export function readListing(value: Listing): ListingData {
  return value[listingData];
}
export function readProduct(value: Product): ProductData {
  return value[productData];
}
export function readIdentified(
  value: IdentifiedProduct,
): Readonly<{ listing: Listing; product: Product; match: MatchEvidence }> {
  return value[identifiedData];
}

function validGtin(value: string): boolean {
  return (
    /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) &&
    Array.from(value, Number)
      .toReversed()
      .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0) %
      10 ===
      0
  );
}

function capacity(
  input: unknown,
): Result<Readonly<{ value: number; unit: "ml" | "GB" | "mAh" }>, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "capacity" });
  }
  const value = input["value"];
  const unit = input["unit"];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    (unit === "ml" || unit === "GB" || unit === "mAh")
    ? ok(Object.freeze({ value, unit }))
    : err({ code: "invalid_data", field: "capacity" });
}

export function parseVariant(input: unknown): Result<Variant, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "variant" });
  }
  if (input["status"] === "unknown") {
    return ok(Object.freeze({ status: "unknown" }));
  }
  const packCount = input["packCount"];
  if (
    input["status"] !== "confirmed" ||
    typeof packCount !== "number" ||
    !Number.isSafeInteger(packCount) ||
    packCount < 1 ||
    input["color"] === undefined ||
    input["capacity"] === undefined
  ) {
    return err({ code: "invalid_data", field: "variant" });
  }
  // Confirmed null dimensions mean not applicable, never not yet fetched.
  return andThen(
    optional(input["color"], (value) => text(value, "color")),
    (color) =>
      map(optional(input["capacity"], capacity), (volume) =>
        Object.freeze({ status: "confirmed", color, capacity: volume, packCount }),
      ),
  );
}

function identity(input: unknown): Result<Identity, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "identity" });
  }
  return andThen(
    optional(input["manufacturer"], (value) => text(value, "manufacturer")),
    (manufacturer) =>
      andThen(
        optional(input["model"], (value) => text(value, "model")),
        (model) =>
          andThen(
            optional(input["gtin"], (value) => text(value, "gtin")),
            (gtin) => {
              if (gtin.tag === "some" && !validGtin(gtin.value)) {
                return err({ code: "invalid_data", field: "gtin" });
              }
              return map(parseVariant(input["variant"]), (variant) =>
                Object.freeze({ manufacturer, model, gtin, variant }),
              );
            },
          ),
      ),
  );
}

export const listingSchema: Schema<Listing> = Object.freeze({
  parse(input: unknown): Result<Listing, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "listing" });
    }
    return andThen(evidence(input["evidence"]), (source) =>
      andThen(listingId(source.provider, input["listingId"]), (id) =>
        andThen(text(input["title"], "title"), (title) =>
          andThen(identity(input["identity"]), (identifiers) =>
            andThen(permissions(input["permissions"]), (rights) =>
              andThen(optional(input["offer"], offerSchema.parse), (offer) =>
                offer.tag === "some" &&
                (!sameListingId(readOffer(offer.value).listingId, id) ||
                  !sameVariant(readOffer(offer.value).variant, identifiers.variant))
                  ? err({ code: "invalid_data", field: "offer_target" })
                  : ok(
                      Object.freeze({
                        [listingData]: Object.freeze({
                          id,
                          title,
                          identity: identifiers,
                          evidence: source,
                          permissions: rights,
                          offer,
                        }),
                      }),
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  },
});

const productSchema: Schema<Product> = Object.freeze({
  parse(input: unknown): Result<Product, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "product" });
    }
    return andThen(evidence(input["evidence"]), (source) =>
      andThen(productId(source.provider, input["productId"]), (id) =>
        andThen(identity(input["identity"]), (identifiers) =>
          map(permissions(input["permissions"]), (rights) =>
            Object.freeze({
              [productData]: Object.freeze({
                id,
                identity: identifiers,
                evidence: source,
                permissions: rights,
              }),
            }),
          ),
        ),
      ),
    );
  },
});

export const productsSchema: Schema<readonly Product[]> = Object.freeze({
  parse(input: unknown): Result<readonly Product[], SchemaError> {
    if (!Array.isArray(input)) {
      return err({ code: "invalid_data", field: "products" });
    }
    const values: readonly unknown[] = input;
    return sequence(values.map((value) => productSchema.parse(value)));
  },
});

export type IdentificationError = Readonly<{
  code:
    | "insufficient_identity"
    | "product_not_found"
    | "ambiguous_product"
    | "conflicting_identity";
}>;

export function hasProductIdentity(value: Identity): boolean {
  return (
    value.variant.status === "confirmed" &&
    (value.gtin.tag === "some" || (value.manufacturer.tag === "some" && value.model.tag === "some"))
  );
}

function sameText(left: Option<string>, right: Option<string>): boolean {
  return (
    left.tag === "some" &&
    right.tag === "some" &&
    left.value.toUpperCase() === right.value.toUpperCase()
  );
}

function differentText(left: Option<string>, right: Option<string>): boolean {
  return left.tag === "some" && right.tag === "some" && !sameText(left, right);
}

export function sameVariant(left: Variant, right: Variant): boolean {
  if (left.status !== "confirmed" || right.status !== "confirmed") {
    return false;
  }
  return (
    left.packCount === right.packCount &&
    ((left.color.tag === "none" && right.color.tag === "none") ||
      sameText(left.color, right.color)) &&
    ((left.capacity.tag === "none" && right.capacity.tag === "none") ||
      (left.capacity.tag === "some" &&
        right.capacity.tag === "some" &&
        left.capacity.value.unit === right.capacity.value.unit &&
        left.capacity.value.value === right.capacity.value.value))
  );
}

function match(left: Identity, right: Identity): "none" | "conflict" | MatchEvidence["method"] {
  const sameGtin =
    left.gtin.tag === "some" &&
    right.gtin.tag === "some" &&
    left.gtin.value.padStart(14, "0") === right.gtin.value.padStart(14, "0");
  const sameModel =
    sameText(left.manufacturer, right.manufacturer) && sameText(left.model, right.model);
  if (
    (sameGtin &&
      (differentText(left.manufacturer, right.manufacturer) ||
        differentText(left.model, right.model) ||
        (left.variant.status === "confirmed" &&
          right.variant.status === "confirmed" &&
          !sameVariant(left.variant, right.variant)))) ||
    (sameModel &&
      left.gtin.tag === "some" &&
      right.gtin.tag === "some" &&
      !sameGtin &&
      sameVariant(left.variant, right.variant))
  ) {
    return "conflict";
  }
  if (!sameVariant(left.variant, right.variant)) {
    return "none";
  }
  if (sameGtin) {
    return "gtin";
  }
  return sameModel ? "manufacturer_model_variant" : "none";
}

export function identifyProduct(
  listing: Listing,
  products: readonly Product[],
): Result<IdentifiedProduct, IdentificationError> {
  const source = readListing(listing);
  if (!hasProductIdentity(source.identity)) {
    return err({ code: "insufficient_identity" });
  }
  const matches = products.map((product) =>
    Object.freeze({ product, method: match(source.identity, readProduct(product).identity) }),
  );
  if (matches.some((value) => value.method === "conflict")) {
    return err({ code: "conflicting_identity" });
  }
  const found = matches.filter((value) => value.method !== "none" && value.method !== "conflict");
  const [candidate] = found;
  if (candidate === undefined) {
    return err({ code: "product_not_found" });
  }
  if (found.length !== 1) {
    return err({ code: "ambiguous_product" });
  }
  if (candidate.method === "none" || candidate.method === "conflict") {
    return err({ code: "product_not_found" });
  }
  return ok(
    Object.freeze({
      [identifiedData]: Object.freeze({
        listing,
        product: candidate.product,
        match: Object.freeze({
          method: candidate.method,
          listing: source.evidence,
          product: readProduct(candidate.product).evidence,
        }),
      }),
    }),
  );
}
