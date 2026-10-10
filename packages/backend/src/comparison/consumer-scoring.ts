import type { Result } from "./algebra.js";
import type { ConsumerCategoryDefinition } from "./consumer-catalog.js";
import type { ConsumerInformation } from "./consumer.js";

export const consumerScoreLevels: readonly string[] = Object.freeze([
  "Clearly less favorable than the alternatives on this field.",
  "Somewhat less favorable than the alternatives on this field.",
  "Comparable, equivalent, or a difference that depends on buyer preference.",
  "Somewhat more favorable than the alternatives on this field.",
  "Clearly more favorable than the alternatives on this field.",
]);

export type ConsumerAssessment = Readonly<{ model: string; index: number; confidence: number }>;
export type ConsumerAssessments = Readonly<
  Record<string, Readonly<Record<string, ConsumerAssessment>>>
>;
export type ConsumerScoring = (
  category: ConsumerCategoryDefinition,
  listings: ReadonlyArray<
    Readonly<{ listingId: string; consumerInformation: ConsumerInformation }>
  >,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<Result<ConsumerAssessments, "unavailable" | "invalid_response">>;

export function consumerAssessmentScore(assessment: ConsumerAssessment | undefined): number | null {
  return assessment !== undefined &&
    /^jev-\d+\.\d+\.\d+$/.test(assessment.model) &&
    Number.isFinite(assessment.index) &&
    assessment.index >= 0 &&
    assessment.index <= 4 &&
    Number.isFinite(assessment.confidence) &&
    assessment.confidence >= 0.6 &&
    assessment.confidence <= 1
    ? Math.round(assessment.index * 25)
    : null;
}
