import type { CatalogCategory, ComparisonJobState, ConsumerComparison } from "./consumer-http.js";

export type ComparisonOperationPhase =
  | "idle"
  | "detecting"
  | "starting"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export function comparisonStageLabel(
  phase: ComparisonOperationPhase,
  stage: string | null,
): string {
  if (phase === "detecting") {
    return "商品URLからカテゴリを確認しています…";
  }
  if (phase === "starting") {
    return "比較を開始しています…";
  }
  if (phase === "queued") {
    return "比較待ちです…";
  }
  if (phase === "running") {
    if (stage === "search") {
      return "候補商品を探索しています…";
    }
    if (stage === "extract") {
      return "仕様を確認しています…";
    }
    return "比較を実行しています…";
  }
  if (phase === "failed") {
    return "比較に失敗しました";
  }
  if (phase === "cancelling") {
    return "キャンセルを確認しています…";
  }
  if (phase === "cancelled") {
    return "比較をキャンセルしました";
  }
  return "";
}

export function phaseFromJobState(state: ComparisonJobState): ComparisonOperationPhase {
  if (state === "queued") {
    return "queued";
  }
  if (state === "running") {
    return "running";
  }
  if (state === "succeeded") {
    return "succeeded";
  }
  if (state === "failed") {
    return "failed";
  }
  return "cancelled";
}

export function shouldPollJob(state: ComparisonJobState): boolean {
  return state === "queued" || state === "running";
}

export function comparisonAxisWeightPercent(category: CatalogCategory, id: string): number {
  const axis = category.axes.find((entry) => entry.id === id);
  if (axis === undefined) {
    throw new Error("Unknown comparison axis");
  }
  return (100 * axis.weight) / category.axes.reduce((total, entry) => total + entry.weight, 0);
}

export function comparisonDetailLayout(
  category: CatalogCategory,
  products: ReadonlyArray<
    Pick<ConsumerComparison["products"][number], "axes" | "consumerInformation">
  >,
): Readonly<{
  primaryAxes: CatalogCategory["axes"];
  detailAxes: CatalogCategory["axes"];
  specificationFields: CatalogCategory["fields"];
}> {
  const hasInformation = (id: string): boolean =>
    products.some((product) => {
      const value = product.consumerInformation.specs[id];
      return value !== null && value !== undefined;
    });
  const axes = category.axes.filter(
    (axis) =>
      axis.id !== "price" &&
      products.some((product) =>
        product.axes.some((entry) => entry.id === axis.id && entry.score !== null),
      ),
  );
  return {
    primaryAxes: axes.slice(0, 6),
    detailAxes: axes.slice(6),
    specificationFields: category.fields.filter(
      (field) => field.kind !== "number" && hasInformation(field.id),
    ),
  };
}

export type ComparisonRequest = Readonly<{ signal: AbortSignal; isCurrent: () => boolean }>;

export function createComparisonRequestScope(): Readonly<{
  begin: () => ComparisonRequest;
  invalidate: () => void;
}> {
  let generation = 0;
  let controller: AbortController | null = null;
  const invalidate = (): void => {
    generation += 1;
    controller?.abort();
    controller = null;
  };
  return {
    invalidate,
    begin: () => {
      invalidate();
      const active = new AbortController();
      const currentGeneration = generation;
      controller = active;
      return {
        signal: active.signal,
        isCurrent: () => currentGeneration === generation && !active.signal.aborted,
      };
    },
  };
}

export async function waitForComparisonPoll(
  signal: AbortSignal,
  milliseconds = 1200,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Comparison polling aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function comparisonDisplayExpiresAt(
  data: ConsumerComparison,
  jobExpiresAt?: string,
): number {
  return Math.min(
    Date.parse(data.source.expiresAt),
    ...data.products.map((product) => Date.parse(product.expiresAt)),
    data.storageExpiresAt === null ? Infinity : Date.parse(data.storageExpiresAt),
    jobExpiresAt === undefined ? Infinity : Date.parse(jobExpiresAt),
  );
}

export function comparisonDisplayRemainingMs(
  data: ConsumerComparison,
  jobExpiresAt?: string,
): number {
  return Math.max(0, comparisonDisplayExpiresAt(data, jobExpiresAt) - Date.now());
}
