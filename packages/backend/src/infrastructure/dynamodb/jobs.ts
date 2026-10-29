import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import {
  authorizeComparisonJob,
  cancelComparisonJobRecord,
  claimComparisonJobRecord,
  comparisonJobCreateExisting,
  comparisonJobExpired,
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
import { valueOf } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import { decodeDynamoPayload, encodeDynamoPayload } from "./codec.js";
import type { DynamoDatabase, DynamoItem } from "./database.js";

type Store = ComparisonJobStore & Readonly<{ cleanup: () => Promise<void> }>;
function generation(job: ComparisonJobRecord): string {
  return `${job.accessKeyDigest}:${job.inputDigest}:${job.expiresAt}`;
}
function interrupted(job: ComparisonJobRecord): ComparisonJobRecord {
  return {
    ...job,
    state: "failed",
    stage: "failed",
    revision: job.revision + 1,
    result: null,
    workerId: null,
    workerLeaseUntil: null,
    error: { code: "job_interrupted" },
  };
}

export function createDynamoComparisonJobStore(
  database: DynamoDatabase,
  table: string,
  clock: () => Instant,
): Store {
  const milliseconds = (): number => Date.parse(valueOf(clock()));
  const unavailable = (): Result<never, ComparisonJobStoreError> =>
    err({ code: "storage_unavailable" });
  const item = (job: ComparisonJobRecord): DynamoItem => {
    const expiry = Date.parse(job.expiresAt);
    const created = expiry - 3_600_000;
    const dueAt =
      job.state === "queued" || job.state === "running"
        ? Math.min(
            expiry,
            Math.max(
              created + 600_000,
              job.workerLeaseUntil === null ? 0 : Date.parse(job.workerLeaseUntil) + 60_000,
            ),
          )
        : job.state === "succeeded" && job.result !== null
          ? Math.min(expiry, Date.parse(job.resultExpiresAt))
          : expiry;
    return {
      key: job.id,
      generation: generation(job),
      revision: job.revision,
      ttl: Math.ceil(expiry / 1000),
      dueAt,
      data: encodeDynamoPayload(job),
    };
  };
  const read = async (
    id: string,
  ): Promise<Result<ComparisonJobRecord | null, ComparisonJobStoreError>> => {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      return err({ code: "job_not_found" });
    }
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const found = await database.get(table, id);
        if (found === null) {
          return ok(null);
        }
        if (found.data === undefined) {
          return unavailable();
        }
        const parsed = comparisonJobRecordSchema.parse(decodeDynamoPayload(found.data));
        if (
          parsed.tag === "err" ||
          parsed.value.id !== id ||
          parsed.value.revision !== found.revision ||
          found.generation !== generation(parsed.value) ||
          found.ttl !== Math.ceil(Date.parse(parsed.value.expiresAt) / 1000)
        ) {
          return unavailable();
        }
        const job = parsed.value;
        // TTL is eventual. Never return expired product content, even before the sweeper runs.
        if (job.result !== null && comparisonJobExpired(job, clock())) {
          const scrubbed = { ...job, result: null, revision: job.revision + 1 };
          if (
            !(await database.put(table, item(scrubbed), {
              kind: "revision",
              revision: job.revision,
              generation: generation(job),
            }))
          ) {
            continue;
          }
          return ok(scrubbed);
        }
        return ok(job);
      }
      return err({ code: "revision_conflict" });
    } catch {
      return unavailable();
    }
  };
  const change = async (
    id: string,
    operation: (
      job: ComparisonJobRecord,
    ) =>
      | Result<ComparisonJobRecord, ComparisonJobStoreError>
      | Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>,
  ): Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>> => {
    try {
      const found = await read(id);
      if (found.tag === "err") {
        return found;
      }
      if (found.value === null) {
        return err({ code: "job_not_found" });
      }
      const next = await operation(found.value);
      if (next.tag === "err" || next.value === found.value) {
        return next;
      }
      const checked = comparisonJobRecordSchema.parse(next.value);
      if (checked.tag === "err") {
        return unavailable();
      }
      const saved = await database.put(table, item(checked.value), {
        kind: "revision",
        revision: found.value.revision,
        generation: generation(found.value),
      });
      return saved ? checked : err({ code: "revision_conflict" });
    } catch {
      return unavailable();
    }
  };
  return Object.freeze({
    persistentResults: true,
    create: async (input) => {
      try {
        const initial = initialComparisonJobRecord(input);
        if (
          comparisonJobRecordSchema.parse(initial).tag === "err" ||
          comparisonJobExpired(initial, clock())
        ) {
          return unavailable();
        }
        if (await database.put(table, item(initial), { kind: "absent" })) {
          return ok({ record: initial, created: true });
        }
        const existing = await read(input.id);
        return existing.tag === "err"
          ? existing
          : existing.value === null
            ? err({ code: "revision_conflict" })
            : comparisonJobCreateExisting(existing.value, input, clock());
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
      await change(id, (job) => {
        const finished = finishComparisonJobRecord(job, workerId, revision, outcome, clock(), true);
        if (finished.tag === "ok" && finished.value.state === "succeeded") {
          try {
            item(finished.value);
          } catch {
            return ok({
              ...finished.value,
              state: "failed",
              stage: "failed",
              result: null,
              error: { code: "result_too_large" },
            });
          }
        }
        return finished;
      }),
    cleanup: async () => {
      // A bounded GSI query avoids scanning all jobs. Strong reads + CAS fence stale index entries.
      const ids = await database.due(table, milliseconds(), 100);
      const deadline = Date.now() + 20_000;
      for (const id of ids) {
        if (Date.now() >= deadline) {
          break;
        }
        const found = await read(id);
        if (found.tag === "err") {
          throw new Error("Job cleanup unavailable");
        }
        if (found.value === null) {
          continue;
        }
        const job = found.value;
        if (Date.parse(job.expiresAt) <= milliseconds()) {
          await database.remove(table, id, job.revision, generation(job));
        } else if (
          (job.state === "queued" || job.state === "running") &&
          Date.parse(job.expiresAt) - 3_600_000 + 600_000 <= milliseconds() &&
          (job.workerLeaseUntil === null ||
            Date.parse(job.workerLeaseUntil) + 60_000 <= milliseconds())
        ) {
          const failed = interrupted(job);
          await database.put(table, item(failed), {
            kind: "revision",
            revision: job.revision,
            generation: generation(job),
          });
        }
      }
    },
  } satisfies Store);
}
