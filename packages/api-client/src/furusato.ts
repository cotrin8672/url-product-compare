import type { CommerceListing } from "./commerce.js";

type FurusatoScoring = Readonly<{
  status: "applied" | "not_configured" | "not_authorized" | "needs_information" | "unavailable";
  calls: 0 | 1;
  scope: "overall";
  items: ReadonlyArray<
    Readonly<{
      score: number | null;
      rank: number | null;
      assessment?: Readonly<{ model: string; index: number; confidence: number }>;
    }>
  >;
}>;

export type FurusatoField = Readonly<{
  id: string;
  label: string;
  status: "known" | "unknown" | "conflict";
  value: string | number | null;
  unit: "g" | "回" | null;
  evidence: ReadonlyArray<Readonly<{ source: "title" | "description"; quote: string }>>;
}>;
export type FurusatoComparison = Readonly<{
  scoring?: FurusatoScoring;
  items: ReadonlyArray<
    Readonly<{
      source: "rakuten_furusato" | "satofull";
      id: string;
      category: FurusatoField;
      fields: readonly FurusatoField[];
      donationPerKg: number | null;
    }>
  >;
  pairs: ReadonlyArray<
    Readonly<{
      left: number;
      right: number;
      status: "comparable" | "partial" | "incompatible";
      reasons: readonly string[];
      unitDonationComparable: boolean;
    }>
  >;
}>;
export type FurusatoComparisonRequest = Readonly<{
  items: ReadonlyArray<Readonly<{ source: "rakuten_furusato" | "satofull"; query: string }>>;
}>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function invalid(): Error {
  return new Error("返礼品の比較結果を検証できませんでした", {
    cause: { code: "invalid_response" },
  });
}
const fieldIds = [
  "origin",
  "storage",
  "shipment",
  "expiry",
  "deliveryMode",
  "perDeliveryGrams",
  "deliveryCount",
  "totalGrams",
  "cultivar",
  "milling",
  "harvestYear",
  "species",
  "cut",
  "grade",
  "processing",
  "municipality",
  "provider",
  "packaging",
  "ingredients",
  "allergens",
  "size",
  "applicationDeadline",
];

function parseField(input: unknown, listing: CommerceListing): FurusatoField {
  if (
    !record(input) ||
    typeof input["id"] !== "string" ||
    (!fieldIds.includes(input["id"]) && input["id"] !== "category") ||
    typeof input["label"] !== "string" ||
    input["label"].length < 1 ||
    input["label"].length > 40 ||
    (input["status"] !== "known" &&
      input["status"] !== "unknown" &&
      input["status"] !== "conflict") ||
    !Array.isArray(input["evidence"]) ||
    input["evidence"].length > 16
  ) {
    throw invalid();
  }
  const id = input["id"],
    value = input["value"],
    status = input["status"];
  const numeric = id.endsWith("Grams") || id === "deliveryCount";
  const unit = id.endsWith("Grams") ? "g" : id === "deliveryCount" ? "回" : null;
  if (
    input["unit"] !== unit ||
    (status !== "known" && value !== null) ||
    (status === "known" &&
      (numeric
        ? typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          value > (id === "deliveryCount" ? 120 : 1_000_000_000)
        : typeof value !== "string" || value.length === 0 || value.length > 100))
  ) {
    throw invalid();
  }
  if (
    status === "known" &&
    id === "category" &&
    value !== "rice" &&
    value !== "meat" &&
    value !== "fruit" &&
    value !== "seafood"
  ) {
    throw invalid();
  }
  if (
    status === "known" &&
    id === "deliveryMode" &&
    value !== "single" &&
    value !== "subscription"
  ) {
    throw invalid();
  }
  const rawEvidence: readonly unknown[] = input["evidence"];
  const evidence = rawEvidence.map((item): FurusatoField["evidence"][number] => {
    if (
      !record(item) ||
      (item["source"] !== "title" && item["source"] !== "description") ||
      typeof item["quote"] !== "string" ||
      item["quote"].length === 0 ||
      item["quote"].length > 2000 ||
      !(item["source"] === "title" ? listing.title : (listing.description ?? "")).includes(
        item["quote"],
      )
    ) {
      throw invalid();
    }
    return Object.freeze({ source: item["source"], quote: item["quote"] });
  });
  if (status === "known" && evidence.length === 0) {
    throw invalid();
  }
  if (value !== null && typeof value !== "string" && typeof value !== "number") {
    throw invalid();
  }
  return Object.freeze({
    id,
    label: input["label"],
    status,
    value,
    unit,
    evidence: Object.freeze(evidence),
  });
}

export function parseFurusatoComparison(
  input: unknown,
  listings: readonly CommerceListing[],
): FurusatoComparison | null {
  if (input === undefined) {
    return null;
  }
  if (
    !record(input) ||
    !Array.isArray(input["items"]) ||
    !Array.isArray(input["pairs"]) ||
    input["items"].length !== listings.length ||
    listings.length > 10 ||
    input["pairs"].length !== (listings.length * (listings.length - 1)) / 2
  ) {
    throw invalid();
  }
  const rawItems: readonly unknown[] = input["items"];
  const items = rawItems.map((raw, index): FurusatoComparison["items"][number] => {
    const listing = listings[index];
    if (
      listing === undefined ||
      (listing.source !== "rakuten_furusato" && listing.source !== "satofull") ||
      !record(raw) ||
      raw["source"] !== listing.source ||
      raw["id"] !== listing.id ||
      !Array.isArray(raw["fields"]) ||
      raw["fields"].length < 8 ||
      raw["fields"].length > fieldIds.length
    ) {
      throw invalid();
    }
    const category = parseField(raw["category"], listing);
    if (category.id !== "category") {
      throw invalid();
    }
    const rawFields: readonly unknown[] = raw["fields"];
    const fields = rawFields.map((item) => parseField(item, listing));
    if (
      fields.some((item) => item.id === "category") ||
      new Set(fields.map((item) => item.id)).size !== fields.length ||
      fieldIds.slice(0, 8).some((id) => !fields.some((item) => item.id === id))
    ) {
      throw invalid();
    }
    const grams = fields.find((item) => item.id === "totalGrams")?.value;
    const amount = listing.amount;
    const expected =
      category.status === "known" &&
      typeof grams === "number" &&
      listing.usage.priceComparison &&
      listing.availability !== "unavailable" &&
      amount?.kind === "donation" &&
      amount.minimum === amount.maximum
        ? Math.round(((amount.minimum * 1000) / grams) * 100) / 100
        : null;
    if (raw["donationPerKg"] !== expected) {
      throw invalid();
    }
    return Object.freeze({
      source: listing.source,
      id: listing.id,
      category,
      fields: Object.freeze(fields),
      donationPerKg: expected,
    });
  });
  const rawPairs: readonly unknown[] = input["pairs"];
  const keys = new Set<string>();
  const pairs = rawPairs.map((raw): FurusatoComparison["pairs"][number] => {
    if (
      !record(raw) ||
      typeof raw["left"] !== "number" ||
      typeof raw["right"] !== "number" ||
      !Number.isSafeInteger(raw["left"]) ||
      !Number.isSafeInteger(raw["right"]) ||
      raw["left"] < 0 ||
      raw["right"] <= raw["left"] ||
      raw["right"] >= items.length ||
      (raw["status"] !== "comparable" &&
        raw["status"] !== "partial" &&
        raw["status"] !== "incompatible") ||
      !Array.isArray(raw["reasons"]) ||
      raw["reasons"].length > 16 ||
      raw["unitDonationComparable"] !== (raw["status"] === "comparable") ||
      (raw["status"] === "comparable") !== (raw["reasons"].length === 0)
    ) {
      throw invalid();
    }
    const key = `${raw["left"]}:${raw["right"]}`;
    if (keys.has(key)) {
      throw invalid();
    }
    keys.add(key);
    const rawReasons: readonly unknown[] = raw["reasons"];
    const reasons = rawReasons.map((reason) => {
      if (typeof reason !== "string" || !/^[a-zA-Z_]{1,100}$/u.test(reason)) {
        throw invalid();
      }
      return reason;
    });
    const first = items[raw["left"]],
      second = items[raw["right"]];
    if (first === undefined || second === undefined) {
      throw invalid();
    }
    const expectedReasons: string[] = [];
    const differentCategory =
      first.category.status === "known" &&
      second.category.status === "known" &&
      first.category.value !== second.category.value;
    if (first.category.status !== "known" || second.category.status !== "known") {
      expectedReasons.push("category_unknown_or_conflicting");
    }
    if (differentCategory) {
      expectedReasons.push("different_category");
    }
    const required = [
      "deliveryMode",
      "storage",
      ...(first.category.value === "rice"
        ? ["milling", "cultivar"]
        : first.category.value === "meat"
          ? ["species", "cut", "processing"]
          : ["species", "processing"]),
    ];
    for (const id of required) {
      const a = first.fields.find((item) => item.id === id),
        b = second.fields.find((item) => item.id === id);
      if (a?.status !== "known" || b?.status !== "known") {
        expectedReasons.push(`${id}_unknown_or_conflicting`);
      } else if (a.value !== b.value) {
        expectedReasons.push(`${id}_different`);
      }
    }
    if (first.donationPerKg === null || second.donationPerKg === null) {
      expectedReasons.push("unit_donation_unavailable");
    }
    if (
      reasons.length !== expectedReasons.length ||
      new Set(reasons).size !== reasons.length ||
      expectedReasons.some((reason) => !reasons.includes(reason)) ||
      raw["status"] !==
        (differentCategory
          ? "incompatible"
          : expectedReasons.length === 0
            ? "comparable"
            : "partial")
    ) {
      throw invalid();
    }
    return Object.freeze({
      left: raw["left"],
      right: raw["right"],
      status: raw["status"],
      reasons: Object.freeze(reasons),
      unitDonationComparable: raw["unitDonationComparable"],
    });
  });
  const comparison = { items: Object.freeze(items), pairs: Object.freeze(pairs) };
  return Object.freeze({
    ...comparison,
    ...(input["scoring"] === undefined
      ? {}
      : { scoring: parseScoring(input["scoring"], comparison, listings) }),
  });
}

function parseScoring(
  raw: unknown,
  comparison: FurusatoComparison,
  listings: readonly CommerceListing[],
): FurusatoScoring {
  if (
    !record(raw) ||
    raw["scope"] !== "overall" ||
    raw["basis"] !== undefined ||
    (raw["calls"] !== 0 && raw["calls"] !== 1) ||
    !Array.isArray(raw["items"]) ||
    raw["items"].length !== comparison.items.length
  ) {
    throw invalid();
  }
  const status = raw["status"];
  if (
    status !== "applied" &&
    status !== "not_configured" &&
    status !== "not_authorized" &&
    status !== "needs_information" &&
    status !== "unavailable"
  ) {
    throw invalid();
  }
  const entries: readonly unknown[] = raw["items"];
  const items = entries.map((entry): FurusatoScoring["items"][number] => {
    if (!record(entry) || entry["axes"] !== undefined) {
      throw invalid();
    }
    if (status !== "applied") {
      if (entry["score"] !== null || entry["rank"] !== null || entry["assessment"] !== undefined) {
        throw invalid();
      }
      return { score: null, rank: null };
    }
    const assessment = entry["assessment"];
    if (
      typeof entry["score"] !== "number" ||
      !Number.isSafeInteger(entry["score"]) ||
      entry["score"] < 0 ||
      entry["score"] > 100 ||
      typeof entry["rank"] !== "number" ||
      !Number.isSafeInteger(entry["rank"]) ||
      entry["rank"] < 1 ||
      entry["rank"] > listings.length ||
      !record(assessment) ||
      typeof assessment["model"] !== "string" ||
      !/^jev-\d+\.\d+\.\d+$/.test(assessment["model"]) ||
      typeof assessment["index"] !== "number" ||
      !Number.isFinite(assessment["index"]) ||
      assessment["index"] < 0 ||
      assessment["index"] > 4 ||
      typeof assessment["confidence"] !== "number" ||
      !Number.isFinite(assessment["confidence"]) ||
      assessment["confidence"] < 0.6 ||
      assessment["confidence"] > 1 ||
      entry["score"] !== Math.round(assessment["index"] * 25)
    ) {
      throw invalid();
    }
    return {
      score: entry["score"],
      rank: entry["rank"],
      assessment: {
        model: assessment["model"],
        index: assessment["index"],
        confidence: assessment["confidence"],
      },
    };
  });
  if (status === "applied") {
    const category = comparison.items[0]?.category;
    if (
      raw["calls"] !== 1 ||
      listings.length < 2 ||
      listings.length > 6 ||
      category?.status !== "known" ||
      listings.some((listing) => !listing.usage.ai || listing.availability === "unavailable") ||
      comparison.items.some(
        (item) =>
          item.category.status !== "known" ||
          item.category.value !== category.value ||
          item.donationPerKg === null ||
          !["deliveryMode", "totalGrams"].every((id) =>
            item.fields.some((field) => field.id === id && field.status === "known"),
          ),
      ) ||
      items.some(
        (item) =>
          item.rank !==
          1 +
            items.filter(
              (other) => other.score !== null && item.score !== null && other.score > item.score,
            ).length,
      )
    ) {
      throw invalid();
    }
  }
  if (
    ((status === "not_configured" || status === "not_authorized") && raw["calls"] !== 0) ||
    (status === "unavailable" && raw["calls"] !== 1)
  ) {
    throw invalid();
  }
  return { status, calls: raw["calls"], scope: "overall", items };
}
