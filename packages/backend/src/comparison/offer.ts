import { andThen, err, ok } from "./algebra.js";
import type { Option, Result } from "./algebra.js";
import { parseVariant } from "./catalog.js";
import type { Variant } from "./catalog.js";
import { evidence, instant, listingId, optional, record, text, valueOf } from "./values.js";
import type { Evidence, Instant, ListingId, Schema, SchemaError } from "./values.js";

const offerData = Symbol("offerData");
type Money = Readonly<{ currency: "JPY" | "USD" | "EUR"; minorUnits: number }>;
type OfferData = Readonly<{
  listingId: ListingId;
  variant: Variant;
  price: Option<Money>;
  shipping: Option<Money>;
  tax: "included" | "excluded" | "unknown";
  stock: "in_stock" | "out_of_stock" | "unknown";
  condition: "new" | "used" | "refurbished";
  destination: string;
  eligibility: "public" | "members";
  quantity: number;
  evidence: Evidence;
  expiresAt: Instant;
}>;
export type Offer = Readonly<{ [offerData]: OfferData }>;

export function readOffer(value: Offer): OfferData {
  return value[offerData];
}

function money(input: unknown): Result<Money, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "money" });
  }
  const currency = input["currency"];
  const minorUnits = input["minorUnits"];
  return (currency === "JPY" || currency === "USD" || currency === "EUR") &&
    typeof minorUnits === "number" &&
    Number.isSafeInteger(minorUnits) &&
    minorUnits >= 0
    ? ok(Object.freeze({ currency, minorUnits }))
    : err({ code: "invalid_data", field: "money" });
}

export const offerSchema: Schema<Offer> = Object.freeze({
  parse(input: unknown): Result<Offer, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "offer" });
    }
    const tax = input["tax"];
    const stock = input["stock"] ?? "unknown";
    const condition = input["condition"];
    const quantity = input["quantity"];
    const eligibility = input["eligibility"];
    if (
      (tax !== "included" && tax !== "excluded" && tax !== "unknown") ||
      (stock !== "in_stock" && stock !== "out_of_stock" && stock !== "unknown") ||
      (condition !== "new" && condition !== "used" && condition !== "refurbished") ||
      (eligibility !== "public" && eligibility !== "members") ||
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      return err({ code: "invalid_data", field: "offer_terms" });
    }
    return andThen(optional(input["price"], money), (price) =>
      andThen(optional(input["shipping"], money), (shipping) =>
        andThen(text(input["destination"], "destination"), (destination) =>
          andThen(evidence(input["evidence"]), (source) =>
            andThen(instant(input["expiresAt"]), (expiresAt) => {
              if (
                valueOf(expiresAt) <= valueOf(source.observedAt) ||
                (price.tag === "some" &&
                  shipping.tag === "some" &&
                  price.value.currency !== shipping.value.currency)
              ) {
                return err({ code: "invalid_data", field: "offer_snapshot" });
              }
              // Price, shipping and stock belong to one atomic observation, never merged snapshots.
              return andThen(listingId(source.provider, input["listingId"]), (target) =>
                andThen(parseVariant(input["variant"]), (variant) =>
                  ok(
                    Object.freeze({
                      [offerData]: Object.freeze({
                        listingId: target,
                        variant,
                        price,
                        shipping,
                        tax,
                        stock,
                        condition,
                        destination,
                        eligibility,
                        quantity,
                        evidence: source,
                        expiresAt,
                      }),
                    }),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  },
});

export type PriceError = Readonly<{ code: "price_not_comparable" }>;

function total(offer: Offer, now: Instant): Result<Money, PriceError> {
  const value = readOffer(offer);
  if (
    value.variant.status !== "confirmed" ||
    value.eligibility !== "public" ||
    value.price.tag === "none" ||
    value.shipping.tag === "none" ||
    value.tax !== "included" ||
    value.stock !== "in_stock" ||
    valueOf(value.expiresAt) <= valueOf(now) ||
    valueOf(value.evidence.observedAt) > valueOf(now)
  ) {
    return err({ code: "price_not_comparable" });
  }
  const minorUnits = value.price.value.minorUnits + value.shipping.value.minorUnits;
  return Number.isSafeInteger(minorUnits)
    ? ok(Object.freeze({ currency: value.price.value.currency, minorUnits }))
    : err({ code: "price_not_comparable" });
}

export function comparePrices(left: Offer, right: Offer, now: Instant): Result<number, PriceError> {
  const a = readOffer(left);
  const b = readOffer(right);
  if (
    a.destination !== b.destination ||
    a.condition !== b.condition ||
    a.eligibility !== b.eligibility ||
    a.quantity !== b.quantity ||
    a.variant.status !== "confirmed" ||
    b.variant.status !== "confirmed" ||
    a.variant.packCount !== b.variant.packCount
  ) {
    return err({ code: "price_not_comparable" });
  }
  return andThen(total(left, now), (x) =>
    andThen(total(right, now), (y) =>
      x.currency === y.currency
        ? ok(Math.sign(x.minorUnits - y.minorUnits))
        : err({ code: "price_not_comparable" }),
    ),
  );
}
