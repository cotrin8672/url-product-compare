import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import {
  authorizeComparisonJob,
  cancelComparisonJobRecord,
  claimComparisonJobRecord,
  comparisonJobCreateExisting,
  comparisonJobExpired,
  finishComparisonJobRecord,
  initialComparisonJobRecord,
  progressComparisonJobRecord,
} from "../../comparison/consumer-jobs.js";
import type {
  ComparisonJobRecord,
  ComparisonJobStore,
  ComparisonJobStoreError,
} from "../../comparison/consumer-jobs.js";
import { instant, valueOf } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

export function createMemoryComparisonJobStore(
  clock: () => Instant = systemTime,
): ComparisonJobStore {
  const jobs = new Map<string, ComparisonJobRecord>();
  let chain: Promise<unknown> = Promise.resolve(null);
  const transaction = async <Value>(
    operation: () =>
      | Result<Value, ComparisonJobStoreError>
      | Promise<Result<Value, ComparisonJobStoreError>>,
  ): Promise<Result<Value, ComparisonJobStoreError>> => {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => null,
      () => null,
    );
    return await result;
  };
  const lookup = (id: string): Result<ComparisonJobRecord, ComparisonJobStoreError> => {
    const job = jobs.get(id);
    if (job === undefined) {
      return err({ code: "job_not_found" });
    }
    if (comparisonJobExpired(job, clock()) && job.result !== null) {
      const scrubbed = Object.freeze({ ...job, result: null });
      jobs.set(id, scrubbed);
      return ok(scrubbed);
    }
    return ok(job);
  };
  const update = (
    id: string,
    change: (job: ComparisonJobRecord) => Result<ComparisonJobRecord, ComparisonJobStoreError>,
  ): Result<ComparisonJobRecord, ComparisonJobStoreError> => {
    const found = lookup(id);
    if (found.tag === "err") {
      return found;
    }
    const next = change(found.value);
    if (next.tag === "ok") {
      jobs.set(id, next.value);
    }
    return next;
  };
  return Object.freeze({
    persistentResults: false,
    create: (input) =>
      transaction(() => {
        const existing = lookup(input.id);
        if (existing.tag === "ok") {
          return comparisonJobCreateExisting(existing.value, input, clock());
        }
        // ponytail: bounded 1024-entry scan; use a TTL heap if local throughput needs more.
        for (const [id, job] of jobs) {
          if (job.expiresAt <= valueOf(clock())) {
            jobs.delete(id);
          } else if (comparisonJobExpired(job, clock()) && job.result !== null) {
            jobs.set(id, Object.freeze({ ...job, result: null }));
          }
        }
        if (jobs.size >= 1024) {
          return err({ code: "storage_unavailable" });
        }
        const job = initialComparisonJobRecord(input);
        jobs.set(input.id, job);
        return ok(Object.freeze({ record: job, created: true }));
      }),
    read: (id) =>
      transaction(() => {
        const found = lookup(id);
        return found.tag === "err" ? ok(null) : found;
      }),
    readAuthorized: (id, accessKey) =>
      transaction(async () => {
        const found = lookup(id);
        return found.tag === "err"
          ? found
          : await authorizeComparisonJob(found.value, accessKey, clock());
      }),
    cancel: (id, accessKey) =>
      transaction(async () => {
        const found = lookup(id);
        if (found.tag === "err") {
          return found;
        }
        const authorized = await authorizeComparisonJob(found.value, accessKey, clock());
        return authorized.tag === "err"
          ? authorized
          : update(id, (job) => ok(cancelComparisonJobRecord(job)));
      }),
    claim: (id, workerId, leaseUntil) =>
      transaction(() =>
        update(id, (job) => claimComparisonJobRecord(job, workerId, leaseUntil, clock())),
      ),
    progress: (id, workerId, revision, progress) =>
      transaction(() =>
        update(id, (job) =>
          progressComparisonJobRecord(job, workerId, revision, progress, clock()),
        ),
      ),
    finish: (id, workerId, revision, outcome) =>
      transaction(() =>
        update(id, (job) =>
          finishComparisonJobRecord(job, workerId, revision, outcome, clock(), false),
        ),
      ),
  } satisfies ComparisonJobStore);
}
function systemTime(): Instant {
  const result = instant(new Date().toISOString());
  if (result.tag === "err") {
    throw new Error("System clock did not produce a valid instant");
  }
  return result.value;
}
