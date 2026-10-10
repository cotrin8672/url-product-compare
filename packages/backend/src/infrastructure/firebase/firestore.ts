import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore, Transaction } from "firebase-admin/firestore";

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
import { instant, record } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

type RunMetadata = Readonly<{
  mode: "demo";
  status: "succeeded" | "failed";
  createdAt: FieldValue;
  expiresAt: Timestamp;
}>;
export function createFirestoreRunStore(
  write: (metadata: RunMetadata) => Promise<unknown> = async (metadata) => {
    const app = getApps()[0] ?? initializeApp();
    return await getFirestore(app).collection("investigation_runs").add(metadata);
  },
): (
  status: RunMetadata["status"],
) => Promise<Result<null, Readonly<{ code: "storage_unavailable" }>>> {
  return async (status) => {
    try {
      // Only operational metadata. Product data has independent storage permissions.
      await write({
        mode: "demo",
        status,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      return ok(null);
    } catch {
      return err({ code: "storage_unavailable" });
    }
  };
}
function readJobDocument(
  id: string,
  data: unknown,
): Result<ComparisonJobRecord, ComparisonJobStoreError> {
  if (!record(data) || !(data["cleanupAt"] instanceof Timestamp)) {
    return err({ code: "storage_unavailable" });
  }
  const parsed = comparisonJobRecordSchema.parse({ ...data, id, result: data["result"] ?? null });
  if (parsed.tag === "err") {
    return err({ code: "storage_unavailable" });
  }
  if (
    parsed.value.state === "succeeded" &&
    parsed.value.result !== null &&
    (!record(parsed.value.result) ||
      instant(parsed.value.result["storageExpiresAt"]).tag === "err" ||
      typeof parsed.value.result["storageExpiresAt"] !== "string" ||
      parsed.value.result["storageExpiresAt"] < parsed.value.resultExpiresAt)
  ) {
    return err({ code: "storage_unavailable" });
  }
  const cleanup = data["cleanupAt"].toMillis();
  const expected = Date.parse(
    parsed.value.state === "succeeded" ? parsed.value.resultExpiresAt : parsed.value.expiresAt,
  );
  return Number.isFinite(cleanup) && cleanup === expected
    ? ok(parsed.value)
    : err({ code: "storage_unavailable" });
}
function jobDocument(
  job: ComparisonJobRecord,
): Readonly<Omit<ComparisonJobRecord, "id"> & { cleanupAt: Timestamp }> {
  const { id: _id, ...data } = job;
  return Object.freeze({
    ...data,
    cleanupAt: Timestamp.fromMillis(
      Date.parse(job.state === "succeeded" ? job.resultExpiresAt : job.expiresAt),
    ),
  });
}
export function createFirestoreComparisonJobStore(
  clock: () => Instant,
  firestore: Firestore = getFirestore(getApps()[0] ?? initializeApp()),
): ComparisonJobStore {
  const collection = firestore.collection("comparison_jobs");
  const run = async <Value>(
    operation: (transaction: Transaction) => Promise<Result<Value, ComparisonJobStoreError>>,
  ): Promise<Result<Value, ComparisonJobStoreError>> => {
    try {
      return await firestore.runTransaction(operation);
    } catch {
      return err({ code: "storage_unavailable" });
    }
  };
  const read = async (
    transaction: Transaction,
    id: string,
  ): Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>> => {
    const document = await transaction.get(collection.doc(id));
    if (!document.exists) {
      return err({ code: "job_not_found" });
    }
    const parsed = readJobDocument(id, document.data());
    if (
      parsed.tag === "ok" &&
      comparisonJobExpired(parsed.value, clock()) &&
      parsed.value.result !== null
    ) {
      transaction.update(collection.doc(id), { result: null });
      return ok(Object.freeze({ ...parsed.value, result: null }));
    }
    return parsed;
  };
  const change = (
    id: string,
    operation: (
      job: ComparisonJobRecord,
    ) =>
      | Result<ComparisonJobRecord, ComparisonJobStoreError>
      | Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>,
  ): Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>> =>
    run(async (transaction) => {
      const found = await read(transaction, id);
      if (found.tag === "err") {
        return found;
      }
      const next = await operation(found.value);
      if (next.tag === "ok" && next.value !== found.value) {
        transaction.update(collection.doc(id), jobDocument(next.value));
      }
      return next;
    });
  return Object.freeze({
    persistentResults: true,
    create: (input) =>
      run(async (transaction) => {
        // The operation digest is the document identity, so empty-query races cannot create duplicates.
        const reference = collection.doc(input.id);
        const existing = await transaction.get(reference);
        if (existing.exists) {
          const parsed = readJobDocument(input.id, existing.data());
          return parsed.tag === "err"
            ? parsed
            : comparisonJobCreateExisting(parsed.value, input, clock());
        }
        const job = initialComparisonJobRecord(input);
        transaction.create(reference, {
          ...jobDocument(job),
          createdAt: FieldValue.serverTimestamp(),
        });
        return ok(Object.freeze({ record: job, created: true }));
      }),
    read: (id) =>
      run(async (transaction) => {
        const found = await read(transaction, id);
        return found.tag === "err" && found.error.code === "job_not_found" ? ok(null) : found;
      }),
    readAuthorized: (id, accessKey) =>
      run(async (transaction) => {
        const found = await read(transaction, id);
        return found.tag === "err"
          ? found
          : await authorizeComparisonJob(found.value, accessKey, clock());
      }),
    cancel: (id, accessKey) =>
      change(id, async (job) => {
        const authorized = await authorizeComparisonJob(job, accessKey, clock());
        return authorized.tag === "err" ? authorized : ok(cancelComparisonJobRecord(job));
      }),
    claim: (id, workerId, leaseUntil) =>
      change(id, (job) => claimComparisonJobRecord(job, workerId, leaseUntil, clock())),
    progress: (id, workerId, revision, progress) =>
      change(id, (job) => progressComparisonJobRecord(job, workerId, revision, progress, clock())),
    finish: (id, workerId, revision, outcome) =>
      change(id, (job) =>
        finishComparisonJobRecord(job, workerId, revision, outcome, clock(), true),
      ),
  } satisfies ComparisonJobStore);
}
