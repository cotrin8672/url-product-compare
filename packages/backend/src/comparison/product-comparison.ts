export type ProductComparisonMode = "price" | "performance" | "ai";
type AxisId = "price" | "power" | "portability" | "warranty";
type Listing = Readonly<{
  listingId: string;
  identityVerified?: boolean;
  tax: "included" | "excluded";
  price: Readonly<{ minimum: number; maximum: number }>;
  specifications?: Readonly<{
    maxPowerW: number | null;
    weightG: number | null;
    warrantyMonths: number | null;
  }>;
}>;
type Assessment = Readonly<{
  rank: number | null;
  recommendationPercent: number | null;
  axes: ReadonlyArray<Readonly<{ id: AxisId; score: number | null }>>;
  reasons: readonly string[];
}>;
type AssessedListing = Listing & Assessment;

export function relativeSpecificationScore(
  own: number | null,
  values: ReadonlyArray<number | null>,
  lowerIsBetter: boolean,
  allowZero = false,
): number | null {
  const known = values.filter(
    (value): value is number =>
      value !== null && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0),
  );
  if (
    own === null ||
    !Number.isFinite(own) ||
    (allowZero ? own < 0 : own <= 0) ||
    known.length === 0 ||
    known.length !== values.length
  ) {
    return null;
  }
  if (own === 0) {
    return lowerIsBetter || Math.max(...known) === 0 ? 100 : 0;
  }
  return Math.round(100 * (lowerIsBetter ? Math.min(...known) / own : own / Math.max(...known)));
}

// This percentage is a relative specification index, not a purchase/satisfaction probability.
export function compareProductListings(
  listings: readonly Listing[],
  mode: ProductComparisonMode,
  sourceConfirmed = true,
): Readonly<{
  status: "ranked" | "needs_information" | "no_match";
  products: readonly AssessedListing[];
}> {
  const ids: readonly AxisId[] =
    mode === "price"
      ? ["price"]
      : mode === "performance"
        ? ["power"]
        : ["price", "power", "portability", "warranty"];
  const value = (listing: Listing, id: AxisId): number | null => {
    switch (id) {
      case "price":
        return listing.tax === "included" &&
          listing.price.minimum === listing.price.maximum &&
          listing.price.minimum > 0
          ? listing.price.minimum
          : null;
      case "power":
        return listing.specifications?.maxPowerW ?? null;
      case "portability":
        return listing.specifications?.weightG ?? null;
      case "warranty":
        return listing.specifications?.warrantyMonths ?? null;
    }
  };
  const complete =
    sourceConfirmed &&
    listings.length > 1 &&
    listings.every(
      (listing) =>
        listing.identityVerified === true &&
        ids.every((id) => {
          const number = value(listing, id);
          return number !== null && Number.isFinite(number) && number > 0;
        }),
    );
  const products = listings.map<AssessedListing>((listing) => {
    const axes = ids.map((id) => {
      const own = value(listing, id);
      const values = listings.map((entry) => value(entry, id));
      const score = relativeSpecificationScore(own, values, id === "price" || id === "portability");
      return Object.freeze({ id, score });
    });
    const recommendationPercent = complete
      ? Math.round(axes.reduce((sum, axis) => sum + (axis.score ?? 0), 0) / axes.length)
      : null;
    return Object.freeze({
      ...listing,
      rank: null,
      recommendationPercent,
      axes: Object.freeze(axes),
      reasons: Object.freeze(complete ? [] : ["比較対象の同定または選択した項目が未確認です"]),
    });
  });
  return Object.freeze({
    status: listings.length === 0 ? "no_match" : complete ? "ranked" : "needs_information",
    products: Object.freeze(
      products
        .map<AssessedListing>((product) =>
          Object.freeze({
            ...product,
            rank:
              product.recommendationPercent === null
                ? null
                : 1 +
                  products.filter((other) =>
                    mode === "price"
                      ? other.price.minimum < product.price.minimum
                      : mode === "performance"
                        ? (other.specifications?.maxPowerW ?? 0) >
                          (product.specifications?.maxPowerW ?? 0)
                        : other.recommendationPercent !== null &&
                          other.recommendationPercent > (product.recommendationPercent ?? 0),
                  ).length,
          }),
        )
        .toSorted((left, right) => {
          const difference = (left.rank ?? 100) - (right.rank ?? 100);
          return difference !== 0 ? difference : left.listingId.localeCompare(right.listingId);
        }),
    ),
  });
}
