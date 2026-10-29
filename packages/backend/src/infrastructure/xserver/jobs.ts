import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import {
  authorizeComparisonJob,
  cancelComparisonJobRecord,
  claimComparisonJobRecord,
  comparisonJobCreateExisting,
  comparisonJobRecordSchema,
  finishComparisonJobRecord,
  initialComparisonJobRecord,
  progressComparisonJobRecord,
} from "../../comparison/consumer-jobs.js";
import type {
  ComparisonJobRecord,
  ComparisonJobStore,
  ComparisonJobStoreError,
} from "../../comparison/consumer-jobs.js";
import { record } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import type { XserverBridge } from "./bridge.js";

export function createXserverComparisonJobStore(
  bridge: XserverBridge,
  clock: () => Instant,
): ComparisonJobStore {
  const unavailable = (): Result<never, ComparisonJobStoreError> =>
    err({ code: "storage_unavailable" });
  const parse = (input: unknown): Result<ComparisonJobRecord, ComparisonJobStoreError> => {
    const parsed = comparisonJobRecordSchema.parse(input);
    return parsed.tag === "ok" ? parsed : unavailable();
  };
  const read = async (
    id: string,
  ): Promise<Result<ComparisonJobRecord | null, ComparisonJobStoreError>> => {
    try {
      const result = await bridge("read", { id });
      if (result === null) {
        return ok(null);
      }
      const parsed = parse(result);
      return parsed.tag === "ok" && parsed.value.id !== id ? unavailable() : parsed;
    } catch {
      return unavailable();
    }
  };
  const change = async (
    id: string,
    operation: (
      job: ComparisonJobRecord,
    ) =>
      | Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>
      | Result<ComparisonJobRecord, ComparisonJobStoreError>,
  ): Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>> => {
    try {
      const current = await read(id);
      if (current.tag === "err") {
        return current;
      }
      if (current.value === null) {
        return err({ code: "job_not_found" });
      }
      const next = await operation(current.value);
      if (next.tag === "err" || next.value === current.value) {
        return next;
      }
      const checked = parse(next.value);
      if (checked.tag === "err") {
        return checked;
      }
      const saved = await bridge("replace", {
        id,
        revision: current.value.revision,
        record: checked.value,
      });
      return saved === true ? checked : err({ code: "revision_conflict" });
    } catch {
      return unavailable();
    }
  };
  return Object.freeze({
    persistentResults: true,
    create: async (input) => {
      try {
        const response = await bridge("create", { record: initialComparisonJobRecord(input) });
        if (!record(response) || typeof response["created"] !== "boolean") {
          return unavailable();
        }
        const job = parse(response["record"]);
        if (job.tag === "err") {
          return job;
        }
        if (job.value.id !== input.id) {
          return unavailable();
        }
        const checked = comparisonJobCreateExisting(job.value, input, clock());
        if (checked.tag === "err") {
          return checked;
        }
        return response["created"]
          ? ok({ record: job.value, created: true })
          : comparisonJobCreateExisting(job.value, input, clock());
      } catch {
        return unavailable();
      }
    },
    read,
    readAuthorized: async (id, key) => {
      const found = await read(id);
      return found.tag === "err"
        ? found
        : found.value === null
          ? err({ code: "job_not_found" })
          : await authorizeComparisonJob(found.value, key, clock());
    },
    cancel: async (id, key) =>
      await change(id, async (job) => {
        const authorized = await authorizeComparisonJob(job, key, clock());
        return authorized.tag === "err" ? authorized : ok(cancelComparisonJobRecord(job));
      }),
    claim: async (id, workerId, leaseUntil) =>
      await change(id, (job) => claimComparisonJobRecord(job, workerId, leaseUntil, clock())),
    progress: async (id, workerId, revision, progress) =>
      await change(id, (job) =>
        progressComparisonJobRecord(job, workerId, revision, progress, clock()),
      ),
    finish: async (id, workerId, revision, outcome) =>
      await change(id, (job) =>
        finishComparisonJobRecord(job, workerId, revision, outcome, clock(), true),
      ),
  } satisfies ComparisonJobStore);
}
