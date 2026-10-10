import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { hasProductIdentity, readProduct } from "./catalog.js";
import type { Product } from "./catalog.js";
import {
  evidence,
  permitted,
  permissions,
  productId,
  record,
  sameProductId,
  text,
  valueOf,
} from "./values.js";
import type { Evidence, Instant, Permissions, ProductId, Schema, SchemaError } from "./values.js";

export type Fact = Readonly<{
  productId: ProductId;
  key: string;
  evidence: Evidence;
  permissions: Permissions;
}> &
  (
    | Readonly<{ status: "confirmed"; value: string | number | boolean; excerpt: string }>
    | Readonly<{ status: "unknown" | "conflicting"; value: null; excerpt: null }>
  );
export const factSchema: Schema<Fact> = Object.freeze({
  parse(input: unknown): Result<Fact, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "fact" });
    }
    const key = text(input["key"], "fact_key");
    const source = evidence(input["evidence"]);
    const rights = permissions(input["permissions"]);
    const value = input["value"];
    const status = input["status"];
    if (key.tag === "err") {
      return key;
    }
    if (source.tag === "err") {
      return source;
    }
    if (rights.tag === "err") {
      return rights;
    }
    const target = productId(source.value.provider, input["productId"]);
    if (target.tag === "err") {
      return target;
    }
    const common = {
      productId: target.value,
      key: key.value,
      evidence: source.value,
      permissions: rights.value,
    };
    if (status === "unknown" || status === "conflicting") {
      return value === null && input["excerpt"] === null
        ? ok(Object.freeze({ ...common, status, value: null, excerpt: null }))
        : err({ code: "invalid_data", field: "fact_status" });
    }
    const excerpt = text(input["excerpt"], "fact_excerpt");
    if (status !== "confirmed" || excerpt.tag === "err") {
      return err({ code: "invalid_data", field: "fact_confirmation" });
    }
    if (
      (typeof value !== "string" || value.trim().length === 0) &&
      (typeof value !== "number" || !Number.isFinite(value)) &&
      typeof value !== "boolean"
    ) {
      return err({ code: "invalid_data", field: "fact_value" });
    }
    return ok(Object.freeze({ ...common, status, value, excerpt: excerpt.value }));
  },
});

export type Preference =
  | Readonly<{ id: string; status: "confirmed"; preference: string }>
  | Readonly<{ id: string; status: "not_applicable" | "needs_confirmation" }>;
export const preferencesSchema: Schema<readonly Preference[]> = Object.freeze({
  parse(input: unknown): Result<readonly Preference[], SchemaError> {
    if (!Array.isArray(input) || input.length === 0 || input.length > 10) {
      return err({ code: "invalid_data", field: "preferences" });
    }
    const output: Preference[] = [];
    for (const entry of input) {
      if (!record(entry)) {
        return err({ code: "invalid_data", field: "preference" });
      }
      const id = entry["id"];
      const status = entry["status"];
      if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) {
        return err({ code: "invalid_data", field: "preference_id" });
      }
      if (status === "confirmed") {
        const preference = text(entry["preference"], "preference");
        if (preference.tag === "err") {
          return preference;
        }
        output.push(Object.freeze({ id, status, preference: preference.value }));
      } else if (
        (status === "not_applicable" || status === "needs_confirmation") &&
        entry["preference"] === undefined
      ) {
        output.push(Object.freeze({ id, status }));
      } else {
        return err({ code: "invalid_data", field: "preference_status" });
      }
    }
    return new Set(output.map((entry) => entry.id)).size === output.length
      ? ok(Object.freeze(output))
      : err({ code: "invalid_data", field: "preference_id" });
  },
});

export type Candidate = Readonly<{ product: Product; facts: readonly Fact[] }>;
export type Requirement =
  | Readonly<{ key: string; comparison: "equals"; value: string | number | boolean }>
  | Readonly<{ key: string; comparison: "at_least" | "at_most"; value: number }>;
type Criterion = Readonly<{
  id: string;
  weight: number;
  factKeys: readonly string[];
  instructions: string;
  levels: readonly string[];
  minimumConfidence?: number;
}>;
export type RankingPolicy = Readonly<{
  version: string;
  category: string;
  mode: string;
  tieMargin: number;
  minimumConfidence: number;
  criteria: readonly Criterion[];
}>;
type ScoreQuestion = Readonly<{
  type: "score";
  instructions: string;
  criteria: Criterion["levels"];
}>;
export type JudgeRequest = Readonly<{
  state: Readonly<{
    category: string;
    mode: string;
    preferences: string;
    facts: Readonly<Record<string, string | number | boolean>>;
    excerpts: Readonly<Record<string, string>>;
  }>;
  questions: Readonly<Record<string, ScoreQuestion>>;
}>;
type JudgeAnswer = Readonly<{
  score: number;
  confidence: number;
  legend: Readonly<Record<string, string>>;
  probabilities: Readonly<Record<string, number>>;
}>;
export type JudgeResponse = Readonly<{
  model: string;
  answers: Readonly<Record<string, JudgeAnswer>>;
}>;
export type Judge = (
  request: JudgeRequest,
) => Promise<
  Result<JudgeResponse, "unavailable" | "invalid_response" | "payment_required" | "unauthorized">
>;
export type RankingError = Readonly<{
  code:
    | "invalid_request"
    | "conditions_need_confirmation"
    | "no_assessment_requested"
    | "insufficient_evidence"
    | "source_not_authorized"
    | "ai_not_authorized"
    | "jev_unavailable"
    | "jev_payment_required"
    | "jev_unauthorized"
    | "invalid_jev_response"
    | "assessment_uncertain";
}>;
type RankedProduct = Readonly<{
  product: Product;
  rank: number;
  index: number;
  model: string;
  policyVersion: string;
  criteria: ReadonlyArray<Readonly<JudgeAnswer & { id: string; evidence: readonly Evidence[] }>>;
}>;
export type Ranking = Readonly<{
  ranked: readonly RankedProduct[];
  excluded: readonly Product[];
  policyVersion: string;
  // Internal index is not a calibrated percentage and must not be shown as one.
  displayPercent: false;
}>;

function validPolicy(policy: RankingPolicy): boolean {
  return (
    policy.version.trim().length > 0 &&
    policy.category.trim().length > 0 &&
    policy.mode.trim().length > 0 &&
    policy.criteria.length > 0 &&
    Number.isFinite(policy.tieMargin) &&
    policy.tieMargin >= 0 &&
    policy.tieMargin < 1 &&
    Number.isFinite(policy.minimumConfidence) &&
    policy.minimumConfidence >= 0 &&
    policy.minimumConfidence <= 1 &&
    Number.isFinite(policy.criteria.reduce((total, criterion) => total + criterion.weight, 0)) &&
    new Set(policy.criteria.map((criterion) => criterion.id)).size === policy.criteria.length &&
    policy.criteria.every(
      (criterion) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(criterion.id) &&
        criterion.instructions.trim().length > 0 &&
        Number.isFinite(criterion.weight) &&
        criterion.weight > 0 &&
        criterion.factKeys.length > 0 &&
        new Set(criterion.factKeys).size === criterion.factKeys.length &&
        criterion.factKeys.every((key) => key.trim().length > 0) &&
        criterion.levels.length >= 2 &&
        criterion.levels.length <= 10 &&
        new Set(criterion.levels).size === criterion.levels.length &&
        criterion.levels.every((level) => level.trim().length > 0) &&
        (criterion.minimumConfidence === undefined ||
          (Number.isFinite(criterion.minimumConfidence) &&
            criterion.minimumConfidence >= 0 &&
            criterion.minimumConfidence <= 1)),
    )
  );
}

// Validate both HTTP responses and injected judges at the same trust boundary.
function roundingRadius(value: number): number {
  // jev-1.13.0 live responses independently round scores and probabilities to hundredths.
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? 0.005 : 1e-9;
}

export function parseScoreAnswer(
  input: unknown,
  levels: readonly string[],
): Result<JudgeAnswer, "invalid_response"> {
  if (
    !record(input) ||
    typeof input["score"] !== "number" ||
    !Number.isFinite(input["score"]) ||
    input["score"] < 0 ||
    input["score"] > levels.length - 1 ||
    typeof input["confidence"] !== "number" ||
    !Number.isFinite(input["confidence"]) ||
    input["confidence"] < 0 ||
    input["confidence"] > 1 ||
    !record(input["legend"]) ||
    !record(input["probabilities"]) ||
    Object.keys(input["legend"]).length !== levels.length ||
    Object.keys(input["probabilities"]).length !== levels.length
  ) {
    return err("invalid_response");
  }
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  const bounds: Array<Readonly<{ index: number; minimum: number; maximum: number }>> = [];
  for (const [index, level] of levels.entries()) {
    const probability = input["probabilities"][String(index)];
    if (
      input["legend"][String(index)] !== level ||
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return err("invalid_response");
    }
    legend[String(index)] = level;
    probabilities[String(index)] = probability;
    const radius = roundingRadius(probability);
    bounds.push(
      Object.freeze({
        index,
        minimum: Math.max(0, probability - radius),
        maximum: Math.min(1, probability + radius),
      }),
    );
  }
  const minimumTotal = bounds.reduce((sum, bound) => sum + bound.minimum, 0);
  const maximumTotal = bounds.reduce((sum, bound) => sum + bound.maximum, 0);
  if (minimumTotal > 1 + 1e-9 || maximumTotal < 1 - 1e-9) {
    return err("invalid_response");
  }
  const meanBound = (descending: boolean): number => {
    let remaining = Math.max(0, 1 - minimumTotal);
    let mean = bounds.reduce((sum, bound) => sum + bound.index * bound.minimum, 0);
    for (const bound of descending ? bounds.toReversed() : bounds) {
      const added = Math.min(remaining, bound.maximum - bound.minimum);
      mean += bound.index * added;
      remaining -= added;
    }
    return mean;
  };
  // There must exist a unit-sum distribution whose mean and entries round to the response.
  // Keep the reported values; never normalize, clamp or replace an inconsistent response.
  const scoreRadius = roundingRadius(input["score"]);
  if (
    meanBound(false) > input["score"] + scoreRadius + 1e-9 ||
    meanBound(true) < input["score"] - scoreRadius - 1e-9
  ) {
    return err("invalid_response");
  }
  return ok(
    Object.freeze({
      score: input["score"],
      confidence: input["confidence"],
      legend: Object.freeze(legend),
      probabilities: Object.freeze(probabilities),
    }),
  );
}

function meets(facts: ReadonlyMap<string, Fact>, requirement: Requirement): boolean {
  const fact = facts.get(requirement.key);
  if (fact === undefined) {
    return false;
  }
  if (requirement.comparison === "equals") {
    return fact.value === requirement.value;
  }
  return (
    typeof fact.value === "number" &&
    (requirement.comparison === "at_least"
      ? fact.value >= requirement.value
      : fact.value <= requirement.value)
  );
}

export async function rankProducts(
  candidates: readonly Candidate[],
  requirements: readonly Requirement[],
  preferences: readonly Preference[],
  policy: RankingPolicy,
  judge: Judge,
  now: Instant,
  clock: () => Instant = () => now,
): Promise<Result<Ranking, RankingError>> {
  if (
    !validPolicy(policy) ||
    candidates.length < 1 ||
    candidates.length > 6 ||
    requirements.some(
      (requirement) =>
        requirement.key.trim().length === 0 ||
        (typeof requirement.value === "number" && !Number.isFinite(requirement.value)),
    ) ||
    candidates.some(
      (candidate) =>
        candidate.facts.length === 0 ||
        !hasProductIdentity(readProduct(candidate.product).identity) ||
        candidate.facts.some(
          (fact) => !sameProductId(fact.productId, readProduct(candidate.product).id),
        ),
    ) ||
    candidates.some((candidate, index) =>
      candidates
        .slice(index + 1)
        .some((other) =>
          sameProductId(readProduct(candidate.product).id, readProduct(other.product).id),
        ),
    )
  ) {
    return err({ code: "invalid_request" });
  }

  const conditions = preferencesSchema.parse(preferences);
  if (
    conditions.tag === "err" ||
    conditions.value.length !== policy.criteria.length ||
    conditions.value.some(
      (entry) => !policy.criteria.some((criterion) => criterion.id === entry.id),
    )
  ) {
    return err({ code: "invalid_request" });
  }
  if (conditions.value.some((entry) => entry.status === "needs_confirmation")) {
    return err({ code: "conditions_need_confirmation" });
  }
  const criteria = policy.criteria.filter((criterion) =>
    conditions.value.some((entry) => entry.id === criterion.id && entry.status === "confirmed"),
  );
  if (criteria.length === 0) {
    return err({ code: "no_assessment_requested" });
  }

  const prepared = candidates.map((candidate) =>
    Object.freeze({
      candidate,
      facts: new Map(
        candidate.facts
          .filter((fact) => fact.status === "confirmed")
          .map((fact) => [fact.key, fact]),
      ),
    }),
  );
  if (
    prepared.some(
      ({ candidate }) =>
        new Set(candidate.facts.map((fact) => fact.key)).size !== candidate.facts.length,
    )
  ) {
    return err({ code: "invalid_request" });
  }
  if (
    prepared.some(
      ({ candidate }) =>
        !permitted(readProduct(candidate.product).permissions.display, now) ||
        valueOf(readProduct(candidate.product).evidence.observedAt) > valueOf(now) ||
        candidate.facts.some(
          (fact) =>
            !permitted(fact.permissions.display, now) ||
            valueOf(fact.evidence.observedAt) > valueOf(now),
        ),
    )
  ) {
    return err({ code: "source_not_authorized" });
  }
  const excluded = prepared.filter(({ facts }) =>
    requirements.some((requirement) => facts.has(requirement.key) && !meets(facts, requirement)),
  );
  const eligible = prepared.filter((entry) => !excluded.includes(entry));
  if (
    eligible.some(({ facts }) => requirements.some((requirement) => !facts.has(requirement.key)))
  ) {
    return err({ code: "insufficient_evidence" });
  }
  if (eligible.length === 0) {
    return err({ code: "insufficient_evidence" });
  }
  if (
    eligible.some(({ facts }) =>
      criteria.some((criterion) => criterion.factKeys.some((key) => !facts.has(key))),
    )
  ) {
    return err({ code: "insufficient_evidence" });
  }
  if (
    eligible.some(
      ({ candidate }) =>
        !permitted(readProduct(candidate.product).permissions.ai, now) ||
        valueOf(readProduct(candidate.product).evidence.observedAt) > valueOf(now),
    )
  ) {
    return err({ code: "ai_not_authorized" });
  }
  const requestedKeys = new Set(criteria.flatMap((criterion) => criterion.factKeys));
  if (
    eligible.some(({ candidate }) =>
      candidate.facts
        .filter((fact) => requestedKeys.has(fact.key))
        .some(
          (fact) =>
            !permitted(fact.permissions.ai, now) ||
            valueOf(fact.evidence.observedAt) > valueOf(now),
        ),
    )
  ) {
    return err({ code: "ai_not_authorized" });
  }

  const weightTotal = criteria.reduce((total, criterion) => total + criterion.weight, 0);
  const responses = await Promise.all(
    eligible.map(
      async ({ facts }) =>
        await Promise.all(
          criteria.map(async (criterion) => {
            const preference = conditions.value.find((entry) => entry.id === criterion.id);
            if (preference?.status !== "confirmed") {
              return err("invalid_response" as const);
            }
            const selected = Array.from(facts).filter(([key]) => criterion.factKeys.includes(key));
            const state = Object.freeze({
              category: policy.category,
              mode: policy.mode,
              preferences: preference.preference,
              facts: Object.freeze(
                Object.fromEntries(selected.map(([key, fact]) => [key, fact.value])),
              ),
              excerpts: Object.freeze(
                Object.fromEntries(selected.map(([key, fact]) => [key, fact.excerpt])),
              ),
            });
            const questions = {
              [criterion.id]: {
                type: "score",
                instructions: criterion.instructions,
                criteria: criterion.levels,
              },
            } satisfies Record<string, ScoreQuestion>;
            try {
              return await judge(Object.freeze({ state, questions }));
            } catch {
              return err("unavailable" as const);
            }
          }),
        ),
    ),
  );
  const completedAt = clock();
  if (valueOf(completedAt) < valueOf(now)) {
    return err({ code: "source_not_authorized" });
  }
  if (
    eligible.some(
      ({ candidate }) =>
        !permitted(readProduct(candidate.product).permissions.display, completedAt) ||
        candidate.facts.some((fact) => !permitted(fact.permissions.display, completedAt)),
    )
  ) {
    return err({ code: "source_not_authorized" });
  }
  if (
    eligible.some(
      ({ candidate }) =>
        !permitted(readProduct(candidate.product).permissions.ai, completedAt) ||
        candidate.facts
          .filter((fact) => requestedKeys.has(fact.key))
          .some((fact) => !permitted(fact.permissions.ai, completedAt)),
    )
  ) {
    return err({ code: "ai_not_authorized" });
  }
  const individual = responses.flat();
  if (individual.some((response) => response.tag === "err" && response.error === "unavailable")) {
    return err({ code: "jev_unavailable" });
  }
  if (
    individual.some((response) => response.tag === "err" && response.error === "payment_required")
  ) {
    return err({ code: "jev_payment_required" });
  }
  if (individual.some((response) => response.tag === "err" && response.error === "unauthorized")) {
    return err({ code: "jev_unauthorized" });
  }
  if (individual.some((response) => response.tag === "err")) {
    return err({ code: "invalid_jev_response" });
  }
  const models = individual.flatMap((response) =>
    response.tag === "ok" ? [response.value.model] : [],
  );
  if (new Set(models).size !== 1) {
    return err({ code: "invalid_jev_response" });
  }
  const ranked: RankedProduct[] = [];
  for (const [index, axes] of responses.entries()) {
    const entry = eligible[index];
    if (entry === undefined) {
      return err({ code: "invalid_jev_response" });
    }
    const scores = criteria.map((criterion, axisIndex) => {
      const response = axes[axisIndex];
      if (
        response?.tag !== "ok" ||
        response.value.model.trim().length === 0 ||
        Object.keys(response.value.answers).length !== 1
      ) {
        return undefined;
      }
      const answer = parseScoreAnswer(response.value.answers[criterion.id], criterion.levels);
      if (answer.tag === "err") {
        return undefined;
      }
      const sources = criterion.factKeys.flatMap((key) => {
        const fact = entry.facts.get(key);
        return fact === undefined ? [] : [fact.evidence];
      });
      return Object.freeze({ id: criterion.id, ...answer.value, evidence: Object.freeze(sources) });
    });
    if (scores.some((score) => score === undefined)) {
      return err({ code: "invalid_jev_response" });
    }
    const validScores = scores.flatMap((score) => (score === undefined ? [] : [score]));
    if (
      validScores.some(
        (score) =>
          score.confidence <
          (criteria.find((criterion) => criterion.id === score.id)?.minimumConfidence ??
            policy.minimumConfidence),
      )
    ) {
      return err({ code: "assessment_uncertain" });
    }
    const weighted =
      validScores.reduce((total, score) => {
        const criterion = criteria.find((value) => value.id === score.id);
        return (
          total + (score.score / ((criterion?.levels.length ?? 2) - 1)) * (criterion?.weight ?? 0)
        );
      }, 0) / weightTotal;
    ranked.push(
      Object.freeze({
        product: entry.candidate.product,
        rank: 0,
        index: weighted,
        model: models[0] ?? "",
        policyVersion: policy.version,
        criteria: Object.freeze(validScores),
      }),
    );
  }
  const sorted = ranked.toSorted((left, right) => {
    const difference = right.index - left.index;
    return difference !== 0
      ? difference
      : valueOf(readProduct(left.product).id).localeCompare(valueOf(readProduct(right.product).id));
  });
  const ordered = sorted.reduce<RankedProduct[]>((all, entry, index) => {
    const previous = all.at(-1);
    const groupLeader =
      previous === undefined ? undefined : all.find((item) => item.rank === previous.rank);
    return [
      ...all,
      Object.freeze({
        ...entry,
        rank:
          previous !== undefined &&
          groupLeader !== undefined &&
          groupLeader.index - entry.index <= policy.tieMargin
            ? previous.rank
            : index + 1,
      }),
    ];
  }, []);
  return ok(
    Object.freeze({
      ranked: Object.freeze(ordered),
      excluded: Object.freeze(excluded.map(({ candidate }) => candidate.product)),
      policyVersion: policy.version,
      displayPercent: false,
    }),
  );
}
