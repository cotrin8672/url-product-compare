import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { record } from "./values.js";

export type ProductSpecifications = Readonly<{
  model: string | null;
  brand: string | null;
  gtin: string | null;
  color: string | null;
  maxPowerW: number | null;
  usbCPorts: number | null;
  usbAPorts: number | null;
  weightG: number | null;
  warrantyMonths: number | null;
}>;

export const numericSpecificationFields = Object.freeze([
  "maxPowerW",
  "usbCPorts",
  "usbAPorts",
  "weightG",
  "warrantyMonths",
] satisfies ReadonlyArray<keyof ProductSpecifications>);
export type NumericSpecificationField = (typeof numericSpecificationFields)[number];
export type SpecificationFact = Readonly<{
  field: keyof ProductSpecifications;
  value: string | number;
  source: "rakuten-api" | "description" | "ai-description";
  sourceUrl: string;
  quote: string;
}>;
export type SpecificationExtractionInput = Readonly<{
  listingId: string;
  description: string;
  evidenceText?: string;
  missingFields: readonly NumericSpecificationField[];
}>;
export type ExtractedSpecifications = Readonly<{
  listingId: string;
  facts: readonly SpecificationFact[];
}>;
export type SpecificationExtractionError = Readonly<{
  code:
    | "invalid_request"
    | "main_ai_unavailable"
    | "main_ai_unauthorized"
    | "main_ai_rate_limited"
    | "invalid_ai_response";
}>;
export type SpecificationExtractor = ((
  inputs: readonly SpecificationExtractionInput[],
) => Promise<Result<readonly ExtractedSpecifications[], SpecificationExtractionError>>) &
  Readonly<{ scope: string }>;

export const emptySpecifications: ProductSpecifications = Object.freeze({
  model: null,
  brand: null,
  gtin: null,
  color: null,
  maxPowerW: null,
  usbCPorts: null,
  usbAPorts: null,
  weightG: null,
  warrantyMonths: null,
});

/** A title token is only a lookup hint; product identity still requires matching API metadata. */
export function titleModelHint(input: string): string | null {
  const title = input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/【(?:SK|SKU|管理番号|商品番号)[-_ ]?\d+】/g, "");
  const models = new Set(
    [...title.matchAll(/\b(?:[A-Z][A-Z0-9]*-[A-Z0-9-]+|[A-Z]{1,8}\d[A-Z0-9]{2,16})\b/g)]
      .map((entry) => entry[0])
      .filter((entry) => /\d/.test(entry) && !/^(?:USB|PD|QC|TYPEC)/.test(entry)),
  );
  const hyphenated = [...models].filter((entry) => entry.includes("-"));
  const candidates = hyphenated.length > 0 ? hyphenated : [...models];
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function numericField(input: unknown): input is NumericSpecificationField {
  return numericSpecificationFields.some((field) => field === input);
}

function boundedNumber(field: NumericSpecificationField, value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  switch (field) {
    case "maxPowerW":
      return value > 0 && value <= 2000;
    case "weightG":
      return value > 0 && value <= 100_000;
    case "warrantyMonths":
      return Number.isInteger(value) && value > 0 && value <= 120;
    case "usbCPorts":
    case "usbAPorts":
      return Number.isInteger(value) && value >= 0 && value <= 32;
  }
}

/** Accept labelled facts only: product-title numbers and unlabeled units do not prove a spec. */
export function readNumericSpecification(
  field: NumericSpecificationField,
  input: string,
  prose = false,
): number | null {
  const text = input.normalize("NFKC");
  let pattern: RegExp;
  switch (field) {
    case "maxPowerW":
      pattern = prose
        ? /(?:最大(?:合計|総)?出力|合計出力|最大電力|(?:出力|output)[^\d\n]{0,12}最大(?:で)?|maximum\s+(?:total\s+)?(?:power|output)|最大(?=\s*\d+(?:\.\d+)?\s*(?:W|ワット)\s*(?:の)?出力)|出力パワー(?=[^\d\n]{0,8}\d+(?:\.\d+)?\s*(?:W|ワット)\s*まで))[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*(W|ワット)/gi
        : /(?:最大(?:合計|総)?出力|合計出力|最大電力|maximum\s+(?:total\s+)?(?:power|output)|最大(?=\s*\d+(?:\.\d+)?\s*(?:W|ワット)\s*(?:の)?出力)|出力パワー(?=[^\d\n]{0,8}\d+(?:\.\d+)?\s*(?:W|ワット)\s*まで))\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(W|ワット)/gi;
      break;
    case "weightG":
      pattern = prose
        ? /(?:本体重量|本体質量|重量|質量|重さ|weight)[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*(kg|g|グラム)/gi
        : /(?:本体重量|本体質量|重量|質量|重さ|weight)\s*[:：=]?\s*(?:約\s*)?(\d+(?:\.\d+)?)\s*(kg|g|グラム)/gi;
      break;
    case "warrantyMonths":
      pattern = prose
        ? /(?:(?:メーカー保証|保証期間|製品保証|保証|warranty)[^\d\n]{0,20}|(?=\d+(?:\.\d+)?\s*(?:年|か月|ヶ月|箇月|月)(?:間)?(?:の)?保証))(\d+(?:\.\d+)?)\s*(年間?|years?|か月|ヶ月|箇月|月間?|months?)/gi
        : /(?:(?:メーカー保証|保証期間|製品保証|保証|warranty)\s*[:：=]?\s*|(?=\d+(?:\.\d+)?\s*(?:年|か月|ヶ月|箇月|月)(?:間)?(?:の)?保証))(\d+(?:\.\d+)?)\s*(年間?|years?|か月|ヶ月|箇月|月間?|months?)/gi;
      break;
    case "usbCPorts":
    case "usbAPorts": {
      const port = field === "usbCPorts" ? "C" : "A";
      pattern = new RegExp(
        `USB\\s*(?:Type\\s*)?[-‐‑–]?\\s*${port}(?:\\s*(?:ポート数|端子数|port\\s*count)\\s*[:：=]?\\s*|\\s*(?:ポート|端子|ports)\\s*[:：=]\\s*|\\s*(?:ポート|端子)(?:を|は|が)?\\s*(?=\\d+\\s*(?:ポート|個|基|口|つ))|\\s*[×x*]\\s*|\\s+(?=\\d+\\s*(?:ポート|個|基|口|つ|ports?))${prose ? "|\\s*(?:ポート|端子)[^\\d\\n]{0,16}(?=\\d+\\s*(?:ポート|個|基|口|つ))" : ""})(\\d+)(?![\\d.])\\s*(ポート|個|基|口|つ|ports?)?`,
        "gi",
      );
      break;
    }
  }
  const values = new Set<number>();
  const totalPowerValues = new Set<number>();
  for (const match of text.matchAll(pattern)) {
    const preceding = text.slice(Math.max(0, match.index - 40), match.index);
    const context = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
    if (
      (field === "weightG" &&
        /(?:梱包|包装|配送|発送|shipping|package|packaged)[^\n。;；]{0,12}$/i.test(preceding)) ||
      (field === "warrantyMonths" &&
        /(?:登録|延長|条件|会員|キャンペーン|追加|registration|extended)/i.test(context))
    ) {
      continue;
    }
    if (
      field === "maxPowerW" &&
      /(?:[CA]\d(?:\/[CA]?\d)*|USB[- ]?[CA]\d|単(?:一)?ポート|各ポート|ポート|PPS|純正充電器|他社充電器)[^\n。;；]{0,16}$/i.test(
        preceding,
      )
    ) {
      continue;
    }
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const unit = (match[2] ?? "").toLowerCase();
    const converted =
      Number(raw) *
      (field === "weightG" && unit === "kg"
        ? 1000
        : field === "warrantyMonths" && /^(?:年|year)/.test(unit)
          ? 12
          : 1);
    if (boundedNumber(field, converted)) {
      values.add(converted);
      if (field === "maxPowerW" && /^(?:最大(?:合計|総)出力|maximum\s+total)/i.test(match[0])) {
        totalPowerValues.add(converted);
      }
    }
  }
  // Contradictory offers, simultaneous-output variants and warranty extensions stay unknown.
  const candidates = totalPowerValues.size > 0 ? totalPowerValues : values;
  return candidates.size === 1 ? ([...candidates][0] ?? null) : null;
}

export function specificationDescriptionFacts(
  description: string,
  sourceUrl: string,
): readonly SpecificationFact[] {
  return Object.freeze(
    numericSpecificationFields.flatMap((field) => {
      const value = readNumericSpecification(field, description);
      if (value === null) {
        return [];
      }
      const line = description
        .split(/[\n。;；]/u)
        .find((entry) => readNumericSpecification(field, entry) === value);
      const candidates = [
        ...description.matchAll(/出力|power|output|USB|重量|質量|重さ|weight|保証|warranty/gi),
      ]
        .map((match) => description.slice(Math.max(0, match.index - 40), match.index + 180))
        .filter((entry) => readNumericSpecification(field, entry) === value);
      const quote = line !== undefined && line.length <= 400 ? line.trim() : candidates[0]?.trim();
      if (quote === undefined) {
        return [];
      }
      return [
        Object.freeze({
          field,
          value,
          source: "description",
          sourceUrl,
          quote,
        } satisfies SpecificationFact),
      ];
    }),
  );
}

/** Model output is untrusted: a copied quote must itself justify the exact number and unit. */
export function parseExtractedSpecifications(
  input: unknown,
  requests: readonly SpecificationExtractionInput[],
): Result<readonly ExtractedSpecifications[], SpecificationExtractionError> {
  if (
    !record(input) ||
    Object.keys(input).length !== 1 ||
    !Array.isArray(input["products"]) ||
    input["products"].length > requests.length
  ) {
    return err({ code: "invalid_ai_response" });
  }
  const output: ExtractedSpecifications[] = [];
  for (const product of input["products"]) {
    if (
      !record(product) ||
      Object.keys(product).length !== 2 ||
      typeof product["listingId"] !== "string" ||
      !Array.isArray(product["facts"]) ||
      product["facts"].length > numericSpecificationFields.length
    ) {
      return err({ code: "invalid_ai_response" });
    }
    const listingId = product["listingId"];
    const request = requests.find((entry) => entry.listingId === listingId);
    if (request === undefined || output.some((entry) => entry.listingId === listingId)) {
      return err({ code: "invalid_ai_response" });
    }
    const facts: SpecificationFact[] = [];
    for (const fact of product["facts"]) {
      if (
        !record(fact) ||
        Object.keys(fact).length !== 3 ||
        !numericField(fact["field"]) ||
        !request.missingFields.includes(fact["field"]) ||
        typeof fact["value"] !== "number" ||
        typeof fact["quote"] !== "string" ||
        fact["quote"].length < 2 ||
        fact["quote"].length > 400 ||
        !(request.evidenceText ?? request.description).includes(fact["quote"]) ||
        facts.some((entry) => entry.field === fact["field"]) ||
        readNumericSpecification(fact["field"], fact["quote"], true) !== fact["value"] ||
        readNumericSpecification(
          fact["field"],
          request.evidenceText ?? request.description,
          true,
        ) !== fact["value"]
      ) {
        return err({ code: "invalid_ai_response" });
      }
      facts.push(
        Object.freeze({
          field: fact["field"],
          value: fact["value"],
          source: "ai-description",
          sourceUrl: "",
          quote: fact["quote"],
        }),
      );
    }
    output.push(Object.freeze({ listingId, facts: Object.freeze(facts) }));
  }
  return ok(Object.freeze(output));
}

export function applySpecificationFacts(
  specifications: ProductSpecifications,
  facts: readonly SpecificationFact[],
): ProductSpecifications {
  const result = { ...specifications };
  for (const field of numericSpecificationFields) {
    const fact = facts.find((entry) => entry.field === field);
    if (result[field] === null && fact !== undefined && typeof fact.value === "number") {
      result[field] = fact.value;
    }
  }
  return Object.freeze(result);
}
