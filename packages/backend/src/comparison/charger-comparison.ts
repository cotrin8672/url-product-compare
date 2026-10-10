import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { hasProductIdentity, readProduct } from "./catalog.js";
import type { Product } from "./catalog.js";
import { assessCharging, chargingContextSchema } from "./charger.js";
import type { ChargerSpecification, ChargingContext, ChargingAssessment } from "./charger.js";
import type { Candidate, RankingError } from "./ranking.js";
import { permitted, record, sameProductId, valueOf } from "./values.js";
import type { Evidence, Instant, ProductId, Schema, SchemaError } from "./values.js";

export type ChargerUse = ChargingContext &
  Readonly<{
    portPreference:
      | "ignore"
      | "prefer_roles"
      | "require_roles"
      | "prefer_numbers"
      | "require_numbers";
    plugPreference:
      | "ignore"
      | "prefer_folding"
      | "require_folding"
      | "prefer_fixed"
      | "require_fixed";
  }>;
export const chargerUseSchema: Schema<ChargerUse> = Object.freeze({
  parse(input: unknown): Result<ChargerUse, SchemaError> {
    const context = chargingContextSchema.parse(input);
    if (context.tag === "err") {
      return context;
    }
    if (!record(input)) {
      return err({ code: "invalid_data", field: "charger_use" });
    }
    const portPreference = input["portPreference"];
    const plugPreference = input["plugPreference"];
    if (
      portPreference !== "ignore" &&
      portPreference !== "prefer_roles" &&
      portPreference !== "require_roles" &&
      portPreference !== "prefer_numbers" &&
      portPreference !== "require_numbers"
    ) {
      return err({ code: "invalid_data", field: "port_preference" });
    }
    if (
      plugPreference !== "ignore" &&
      plugPreference !== "prefer_folding" &&
      plugPreference !== "require_folding" &&
      plugPreference !== "prefer_fixed" &&
      plugPreference !== "require_fixed"
    ) {
      return err({ code: "invalid_data", field: "plug_preference" });
    }
    return ok(Object.freeze({ ...context.value, portPreference, plugPreference }));
  },
});
type FeatureScore = Readonly<{
  id: "port_operation" | "plug_storage";
  level: 0 | 1 | 2;
  evidence: Evidence;
}>;
type ComparedCharger = Readonly<{
  product: Product;
  charging: ChargingAssessment;
  status: "eligible" | "excluded" | "pending";
  reasons: readonly string[];
  axes: readonly FeatureScore[];
  rank: number | null;
}>;
export type ChargerComparison = Readonly<{
  status: "ranked" | "unranked" | "needs_information" | "no_match";
  policyVersion: "usb-c-confirmed-features-v1";
  sourceProductId: ProductId;
  products: readonly ComparedCharger[];
  displayPercent: false;
}>;

export function compareChargerFeatures(
  candidates: ReadonlyArray<Candidate & { specification: ChargerSpecification }>,
  sourceProductId: ProductId,
  use: ChargerUse,
  now: Instant,
): Result<ChargerComparison, RankingError> {
  if (
    candidates.length < 1 ||
    candidates.length > 6 ||
    candidates.filter((candidate) =>
      sameProductId(readProduct(candidate.product).id, sourceProductId),
    ).length !== 1 ||
    candidates.some(
      (candidate, index) =>
        !hasProductIdentity(readProduct(candidate.product).identity) ||
        !sameProductId(readProduct(candidate.product).id, candidate.specification.productId) ||
        candidates
          .slice(index + 1)
          .some((other) =>
            sameProductId(readProduct(candidate.product).id, readProduct(other.product).id),
          ) ||
        candidate.facts.some(
          (fact) => !sameProductId(fact.productId, readProduct(candidate.product).id),
        ) ||
        new Set(candidate.facts.map((fact) => fact.key)).size !== candidate.facts.length,
    )
  ) {
    return err({ code: "invalid_request" });
  }
  if (
    candidates.some(
      (candidate) =>
        !permitted(readProduct(candidate.product).permissions.display, now) ||
        valueOf(readProduct(candidate.product).evidence.observedAt) > valueOf(now),
    )
  ) {
    return err({ code: "source_not_authorized" });
  }
  const products: ComparedCharger[] = candidates.map((candidate) => {
    const charging = assessCharging(candidate.specification, use, now);
    if (charging.status !== "compatible") {
      return Object.freeze({
        product: candidate.product,
        charging,
        status: charging.status === "unknown" ? "pending" : "excluded",
        reasons: Object.freeze([charging.reason]),
        axes: Object.freeze([]),
        rank: null,
      });
    }
    const axes: FeatureScore[] = [];
    const missing: string[] = [];
    const mismatches: string[] = [];
    const preferences = [
      { id: "port_operation", key: "printedPortMarking", preference: use.portPreference },
      { id: "plug_storage", key: "plugDesign", preference: use.plugPreference },
    ] as const;
    for (const axis of preferences) {
      if (axis.preference === "ignore") {
        continue;
      }
      const fact = candidate.facts.find((entry) => entry.key === axis.key);
      if (
        fact?.status !== "confirmed" ||
        !permitted(fact.permissions.display, now) ||
        valueOf(fact.evidence.observedAt) > valueOf(now)
      ) {
        missing.push(axis.key);
        continue;
      }
      let level: 0 | 1 | 2;
      if (axis.id === "port_operation") {
        if (
          fact.value !== "unmarked" &&
          fact.value !== "numbered" &&
          fact.value !== "device_role"
        ) {
          missing.push(axis.key);
          continue;
        }
        const preferred = axis.preference.endsWith("roles") ? "device_role" : "numbered";
        level = fact.value === preferred ? 2 : fact.value === "unmarked" ? 0 : 1;
      } else {
        if (fact.value !== "fixed" && fact.value !== "capped" && fact.value !== "folding") {
          missing.push(axis.key);
          continue;
        }
        level = axis.preference.endsWith("fixed")
          ? fact.value === "folding"
            ? 0
            : 2
          : fact.value === "folding"
            ? 2
            : fact.value === "capped"
              ? 1
              : 0;
      }
      axes.push(Object.freeze({ id: axis.id, level, evidence: fact.evidence }));
      if (axis.preference.startsWith("require_") && level !== 2) {
        mismatches.push(axis.key);
      }
    }
    return Object.freeze({
      product: candidate.product,
      charging,
      status: mismatches.length > 0 ? "excluded" : missing.length > 0 ? "pending" : "eligible",
      reasons: Object.freeze([
        ...mismatches.map((key) => `required_${key}`),
        ...missing.map((key) => `unverified_${key}`),
      ]),
      axes: Object.freeze(axes),
      rank: null,
    });
  });
  const status = products.some((product) => product.status === "pending")
    ? "needs_information"
    : products.every((product) => product.status === "excluded")
      ? "no_match"
      : use.portPreference === "ignore" && use.plugPreference === "ignore"
        ? "unranked"
        : "ranked";
  // Only complete, common axes contribute. Missing evidence never changes weights or becomes zero.
  const score = (product: ComparedCharger): number =>
    product.axes.reduce((sum, axis) => sum + axis.level, 0);
  const ordered = products.toSorted((left, right) => {
    const order =
      (left.status === "eligible" ? 0 : left.status === "pending" ? 1 : 2) -
      (right.status === "eligible" ? 0 : right.status === "pending" ? 1 : 2);
    if (order !== 0) {
      return order;
    }
    const difference =
      status === "ranked" && left.status === "eligible" && right.status === "eligible"
        ? score(right) - score(left)
        : 0;
    return difference !== 0
      ? difference
      : valueOf(readProduct(left.product).id).localeCompare(valueOf(readProduct(right.product).id));
  });
  const eligible = ordered.filter((product) => product.status === "eligible");
  return ok(
    Object.freeze({
      status,
      policyVersion: "usb-c-confirmed-features-v1",
      sourceProductId,
      displayPercent: false,
      products: Object.freeze(
        ordered.map((product) =>
          Object.freeze({
            ...product,
            rank:
              status === "ranked" && product.status === "eligible"
                ? 1 + eligible.filter((other) => score(other) > score(product)).length
                : null,
          }),
        ),
      ),
    }),
  );
}
