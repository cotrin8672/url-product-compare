import type { Result } from "./algebra.js";
import type { CommerceListing } from "./commerce.js";
import { consumerAssessmentScore } from "./consumer-scoring.js";
import type { ConsumerAssessment } from "./consumer-scoring.js";
import type { FurusatoComparison, FurusatoScoring } from "./furusato.js";

type FurusatoScoringInput = Readonly<{
  items: ReadonlyArray<
    Readonly<{ listingId: string; donation: number; profile: FurusatoComparison["items"][number] }>
  >;
  pairs: FurusatoComparison["pairs"];
}>;
export type FurusatoOverallScoring = (
  input: FurusatoScoringInput,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<
  Result<Readonly<Record<string, ConsumerAssessment>>, "unavailable" | "invalid_response">
>;

export async function scoreFurusatoListings(
  listings: readonly CommerceListing[],
  comparison: FurusatoComparison,
  score: FurusatoOverallScoring | undefined,
  clock: () => number,
  signal?: AbortSignal,
): Promise<FurusatoScoring> {
  const empty = (status: FurusatoScoring["status"], calls: 0 | 1 = 0): FurusatoScoring => ({
    status,
    calls,
    scope: "overall",
    items: listings.map(() => ({ score: null, rank: null })),
  });
  signal?.throwIfAborted();
  if (score === undefined) {
    return empty("not_configured");
  }
  if (listings.some((listing) => !listing.usage.ai)) {
    return empty("not_authorized");
  }
  const category = comparison.items[0]?.category;
  if (
    listings.length < 2 ||
    listings.length > 6 ||
    comparison.items.length !== listings.length ||
    category?.status !== "known" ||
    comparison.items.some(
      (item, index) =>
        item.source !== listings[index]?.source ||
        item.id !== listings[index].id ||
        item.category.status !== "known" ||
        item.category.value !== category.value ||
        item.donationPerKg === null ||
        !["deliveryMode", "totalGrams"].every((id) =>
          item.fields.some((field) => field.id === id && field.status === "known"),
        ),
    ) ||
    listings.some(
      (listing) =>
        listing.availability === "unavailable" || Date.parse(listing.expiresAt) <= clock(),
    )
  ) {
    return empty("needs_information");
  }
  const input: FurusatoScoringInput = {
    items: comparison.items.flatMap((profile, index) => {
      const listing = listings[index];
      const amount = listing?.amount;
      return listing === undefined ||
        amount?.kind !== "donation" ||
        amount.minimum !== amount.maximum
        ? []
        : [{ listingId: `${listing.source}:${listing.id}`, donation: amount.minimum, profile }];
    }),
    pairs: comparison.pairs,
  };
  if (
    input.items.length !== listings.length ||
    new Set(input.items.map((item) => item.listingId)).size !== listings.length
  ) {
    return empty("needs_information");
  }
  try {
    const result = await score(input, signal === undefined ? {} : { signal });
    signal?.throwIfAborted();
    if (result.tag === "err") {
      return empty("unavailable", 1);
    }
    if (listings.some((listing) => Date.parse(listing.expiresAt) <= clock())) {
      return empty("needs_information", 1);
    }
    const items = input.items.map((item) => {
      const assessment = result.value[item.listingId];
      const value = consumerAssessmentScore(assessment);
      return {
        score: value,
        ...(value === null || assessment === undefined ? {} : { assessment }),
      };
    });
    // A rank must cover the same alternatives. Never rank a confident subset against missing scores.
    if (items.some((item) => item.score === null)) {
      return empty("needs_information", 1);
    }
    return {
      status: "applied",
      calls: 1,
      scope: "overall",
      items: items.map((item) => ({
        ...item,
        rank:
          1 +
          items.filter(
            (other) => other.score !== null && item.score !== null && other.score > item.score,
          ).length,
      })),
    };
  } catch {
    signal?.throwIfAborted();
    return empty("unavailable", 1);
  }
}
