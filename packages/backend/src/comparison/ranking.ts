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
  value: string | number | boolean;
  evidence: Evidence;
  permissions: Permissions;
}>;
export const factSchema: Schema<Fact> = Object.freeze({
  parse(input: unknown): Result<Fact, SchemaError> {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "fact" });
    }
    const key = text(input["key"], "fact_key");
    const source = evidence(input["evidence"]);
    const rights = permissions(input["permissions"]);
    const value = input["value"];
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
    if (
      (typeof value !== "string" || value.trim().length === 0) &&
      (typeof value !== "number" || !Number.isFinite(value)) &&
      typeof value !== "boolean"
    ) {
      return err({ code: "invalid_data", field: "fact_value" });
    }
    return ok(
      Object.freeze({
        productId: target.value,
        key: key.value,
        value,
        evidence: source.value,
        permissions: rights.value,
      }),
    );
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
  levels: readonly [string, string, string, string, string];
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
  }>;
  questions: Readonly<Record<string, ScoreQuestion>>;
}>;
type JudgeAnswer = Readonly<{ score: number; confidence: number }>;
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
  criteria: ReadonlyArray<
    Readonly<{ id: string; score: number; confidence: number; evidence: readonly Evidence[] }>
  >;
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
    new Set(policy.criteria.map((criterion) => criterion.id)).size === policy.criteria.length &&
    policy.criteria.every(
      (criterion) =>
        criterion.id.trim().length > 0 &&
        criterion.instructions.trim().length > 0 &&
        Number.isFinite(criterion.weight) &&
        criterion.weight > 0 &&
        criterion.factKeys.length > 0 &&
        new Set(criterion.factKeys).size === criterion.factKeys.length &&
        criterion.factKeys.every((key) => key.trim().length > 0) &&
        criterion.levels.every((level) => level.trim().length > 0),
    )
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
  preferences: string,
  policy: RankingPolicy,
  judge: Judge,
  now: Instant,
): Promise<Result<Ranking, RankingError>> {
  if (
    !validPolicy(policy) ||
    candidates.length < 1 ||
    candidates.length > 6 ||
    preferences.trim().length === 0 ||
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

  const prepared = candidates.map((candidate) =>
    Object.freeze({ candidate, facts: new Map(candidate.facts.map((fact) => [fact.key, fact])) }),
  );
  if (prepared.some(({ candidate, facts }) => facts.size !== candidate.facts.length)) {
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
  if (
    prepared.some(({ facts }) => requirements.some((requirement) => !facts.has(requirement.key)))
  ) {
    return err({ code: "insufficient_evidence" });
  }
  const excluded = prepared.filter(({ facts }) =>
    requirements.some((requirement) => !meets(facts, requirement)),
  );
  const eligible = prepared.filter(({ facts }) =>
    requirements.every((requirement) => meets(facts, requirement)),
  );
  if (eligible.length === 0) {
    return err({ code: "insufficient_evidence" });
  }
  if (
    eligible.some(({ facts }) =>
      policy.criteria.some((criterion) => criterion.factKeys.some((key) => !facts.has(key))),
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
  if (
    eligible.some(({ candidate }) =>
      candidate.facts.some(
        (fact) =>
          !permitted(fact.permissions.ai, now) || valueOf(fact.evidence.observedAt) > valueOf(now),
      ),
    )
  ) {
    return err({ code: "ai_not_authorized" });
  }

  const questions = Object.fromEntries(
    policy.criteria.map((criterion) => [
      criterion.id,
      Object.freeze({
        type: "score",
        instructions: criterion.instructions,
        criteria: criterion.levels,
      }),
    ]),
  ) satisfies Record<string, ScoreQuestion>;
  const weightTotal = policy.criteria.reduce((total, criterion) => total + criterion.weight, 0);
  const responses = await Promise.all(
    eligible.map(async ({ facts }) => {
      const state = Object.freeze({
        category: policy.category,
        mode: policy.mode,
        preferences,
        facts: Object.freeze(
          Object.fromEntries(Array.from(facts, ([key, fact]) => [key, fact.value])),
        ),
      });
      try {
        return await judge(Object.freeze({ state, questions }));
      } catch {
        return err("unavailable" as const);
      }
    }),
  );
  if (responses.some((response) => response.tag === "err" && response.error === "unavailable")) {
    return err({ code: "jev_unavailable" });
  }
  if (
    responses.some((response) => response.tag === "err" && response.error === "payment_required")
  ) {
    return err({ code: "jev_payment_required" });
  }
  if (responses.some((response) => response.tag === "err" && response.error === "unauthorized")) {
    return err({ code: "jev_unauthorized" });
  }
  if (responses.some((response) => response.tag === "err")) {
    return err({ code: "invalid_jev_response" });
  }
  const models = responses.flatMap((response) =>
    response.tag === "ok" ? [response.value.model] : [],
  );
  if (new Set(models).size !== 1) {
    return err({ code: "invalid_jev_response" });
  }
  const ranked: RankedProduct[] = [];
  for (const [index, response] of responses.entries()) {
    const entry = eligible[index];
    if (response.tag !== "ok" || entry === undefined) {
      return err({ code: "invalid_jev_response" });
    }
    if (
      response.value.model.trim().length === 0 ||
      Object.keys(response.value.answers).length !== policy.criteria.length
    ) {
      return err({ code: "invalid_jev_response" });
    }
    const scores = policy.criteria.map((criterion) => {
      const answer = response.value.answers[criterion.id];
      if (
        answer === undefined ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > 4 ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return undefined;
      }
      const sources = criterion.factKeys.flatMap((key) => {
        const fact = entry.facts.get(key);
        return fact === undefined ? [] : [fact.evidence];
      });
      return Object.freeze({
        id: criterion.id,
        score: answer.score,
        confidence: answer.confidence,
        evidence: Object.freeze(sources),
      });
    });
    if (scores.some((score) => score === undefined)) {
      return err({ code: "invalid_jev_response" });
    }
    const validScores = scores.flatMap((score) => (score === undefined ? [] : [score]));
    if (validScores.some((score) => score.confidence < policy.minimumConfidence)) {
      return err({ code: "assessment_uncertain" });
    }
    const weighted =
      validScores.reduce((total, score) => {
        const criterion = policy.criteria.find((value) => value.id === score.id);
        return total + score.score * (criterion?.weight ?? 0);
      }, 0) /
      (4 * weightTotal);
    ranked.push(
      Object.freeze({
        product: entry.candidate.product,
        rank: 0,
        index: weighted,
        model: response.value.model,
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
