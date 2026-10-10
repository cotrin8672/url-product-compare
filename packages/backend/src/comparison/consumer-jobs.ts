import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import type { ConsumerSort } from "./consumer.js";
import { instant, record, valueOf } from "./values.js";
import type { Instant, Schema } from "./values.js";

type ComparisonJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ComparisonJobProgress = Readonly<{ pages: number; examined: number }>;
export type ComparisonJobInput = Readonly<{
  url: string;
  keyword: string | null;
  category: string | null;
  conditions: unknown;
  sort: ConsumerSort;
}>;
export type ComparisonJobSnapshot = Readonly<{
  id: string;
  accessKey: string;
  state: ComparisonJobState;
  revision: number;
  stage: string;
  progress: ComparisonJobProgress;
  expiresAt: string;
  result?: unknown;
  error?: Readonly<{ code: string }>;
}>;
export type ComparisonJobPublicSnapshot = Readonly<Omit<ComparisonJobSnapshot, "accessKey">>;
export type ComparisonJobStoreError = Readonly<{
  code:
    | "job_not_found"
    | "job_forbidden"
    | "job_expired"
    | "idempotency_conflict"
    | "storage_unavailable"
    | "job_not_claimable"
    | "revision_conflict"
    | "job_terminal"
    | "result_storage_denied";
}>;
export type ComparisonJobCreateInput = Readonly<{
  id: string;
  input: ComparisonJobInput;
  accessKeyDigest: string;
  inputDigest: string;
  expiresAt: string;
}>;
export type ComparisonJobRecord = Readonly<{
  id: string;
  accessKeyDigest: string;
  inputDigest: string;
  input: ComparisonJobInput;
  state: ComparisonJobState;
  revision: number;
  stage: string;
  progress: ComparisonJobProgress;
  expiresAt: string;
  resultExpiresAt: string;
  result: unknown;
  error: Readonly<{ code: string }> | null;
  workerId: string | null;
  workerLeaseUntil: string | null;
}>;
export type ComparisonJobCreateResult = Readonly<{ record: ComparisonJobRecord; created: boolean }>;
export type ComparisonJobOutcome =
  | Readonly<{
      kind: "succeeded";
      result: unknown;
      resultExpiresAt: string;
      storageExpiresAt: string | null;
    }>
  | Readonly<{ kind: "failed"; error: Readonly<{ code: string }> }>;
export type ComparisonJobStore = Readonly<{
  persistentResults: boolean;
  create: (
    input: ComparisonJobCreateInput,
  ) => Promise<Result<ComparisonJobCreateResult, ComparisonJobStoreError>>;
  read: (id: string) => Promise<Result<ComparisonJobRecord | null, ComparisonJobStoreError>>;
  readAuthorized: (
    id: string,
    accessKey: string,
  ) => Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>;
  cancel: (
    id: string,
    accessKey: string,
  ) => Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>;
  claim: (
    id: string,
    workerId: string,
    leaseUntil: string,
  ) => Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>;
  progress: (
    id: string,
    workerId: string,
    expectedRevision: number,
    update: Readonly<{ stage: string; progress: ComparisonJobProgress }>,
  ) => Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>;
  finish: (
    id: string,
    workerId: string,
    expectedRevision: number,
    outcome: ComparisonJobOutcome,
  ) => Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>>;
}>;
export type ConsumerComparisonRunner = Readonly<{
  compare: (
    input: ComparisonJobInput,
    options: Readonly<{
      signal: AbortSignal;
      onProgress: (
        progress: Readonly<{ stage: string; pages: number; examined: number }>,
      ) => Promise<void>;
    }>,
  ) => Promise<Result<unknown, Readonly<{ code: string }>>>;
}>;

const comparisonJobMetadataLifetimeMs = 60 * 60 * 1000;
const comparisonJobResultLifetimeMs = 15 * 60 * 1000;
const comparisonJobWorkerLeaseMs = 45 * 1000;
const comparisonJobMaxSerializedResultBytes = 512_000;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function digestComparisonJobAccessKey(accessKey: string): Promise<string> {
  return await digest(accessKey);
}
async function comparisonJobAccessKeyMatches(
  expected: string,
  accessKey: string,
): Promise<boolean> {
  const actual = await digestComparisonJobAccessKey(accessKey);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return entries.map(canonicalJson);
  }
  if (record(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}
export async function digestComparisonJobInput(input: ComparisonJobInput): Promise<string> {
  return await digest(JSON.stringify(canonicalJson(input)));
}
function validInstant(value: unknown): value is string {
  return instant(value).tag === "ok";
}
function boundedJson(value: unknown, limit: number): boolean {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" && new TextEncoder().encode(serialized).length <= limit;
  } catch {
    return false;
  }
}
function validProgress(value: unknown): value is ComparisonJobProgress {
  return (
    record(value) &&
    typeof value["pages"] === "number" &&
    Number.isSafeInteger(value["pages"]) &&
    value["pages"] >= 0 &&
    typeof value["examined"] === "number" &&
    Number.isSafeInteger(value["examined"]) &&
    value["examined"] >= 0
  );
}
function validState(value: unknown): value is ComparisonJobState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  );
}
function validJobError(value: unknown): value is Readonly<{ code: string }> | null {
  return (
    value === null ||
    (record(value) &&
      typeof value["code"] === "string" &&
      value["code"].length > 0 &&
      value["code"].length <= 64)
  );
}
const comparisonJobInputSchema: Schema<ComparisonJobInput> = Object.freeze({
  parse(input) {
    if (
      !record(input) ||
      typeof input["url"] !== "string" ||
      input["url"].length === 0 ||
      input["url"].length > 2048 ||
      !(
        input["keyword"] === null ||
        (typeof input["keyword"] === "string" &&
          new TextEncoder().encode(input["keyword"]).length <= 128)
      ) ||
      !(
        input["category"] === null ||
        (typeof input["category"] === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(input["category"]))
      ) ||
      !record(input["conditions"]) ||
      !boundedJson(input["conditions"], 4096) ||
      !(
        input["sort"] === "price" ||
        input["sort"] === "recommendation" ||
        input["sort"] === "specifications"
      )
    ) {
      return err({ code: "invalid_data", field: "job.input" });
    }
    return ok(
      Object.freeze({
        url: input["url"],
        keyword: input["keyword"],
        category: input["category"],
        conditions: input["conditions"],
        sort: input["sort"],
      }),
    );
  },
});
export const comparisonJobRecordSchema: Schema<ComparisonJobRecord> = Object.freeze({
  parse(input) {
    if (!record(input)) {
      return err({ code: "invalid_data", field: "job" });
    }
    const parsedInput = comparisonJobInputSchema.parse(input["input"]);
    const error = input["error"];
    if (
      parsedInput.tag === "err" ||
      typeof input["id"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(input["id"]) ||
      typeof input["accessKeyDigest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(input["accessKeyDigest"]) ||
      typeof input["inputDigest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(input["inputDigest"]) ||
      !validState(input["state"]) ||
      typeof input["revision"] !== "number" ||
      !Number.isSafeInteger(input["revision"]) ||
      input["revision"] < 1 ||
      typeof input["stage"] !== "string" ||
      input["stage"].length > 64 ||
      !validProgress(input["progress"]) ||
      !validInstant(input["expiresAt"]) ||
      !validInstant(input["resultExpiresAt"]) ||
      !validJobError(error) ||
      !(
        input["workerId"] === null ||
        (typeof input["workerId"] === "string" && input["workerId"].length <= 128)
      ) ||
      !(input["workerLeaseUntil"] === null || validInstant(input["workerLeaseUntil"])) ||
      !boundedJson(input["result"], comparisonJobMaxSerializedResultBytes) ||
      (input["state"] !== "succeeded" && input["result"] !== null) ||
      (input["state"] === "failed" ? error === null : error !== null) ||
      (input["state"] === "running"
        ? input["workerId"] === null || input["workerLeaseUntil"] === null
        : input["workerId"] !== null || input["workerLeaseUntil"] !== null)
    ) {
      return err({ code: "invalid_data", field: "job" });
    }
    if (input["state"] === "succeeded" && input["result"] !== null) {
      const beforeExpiry = instant(
        new Date(Date.parse(input["resultExpiresAt"]) - 1).toISOString(),
      );
      const window =
        beforeExpiry.tag === "ok" ? resultWindow(input["result"], beforeExpiry.value) : null;
      if (
        window?.tag !== "ok" ||
        input["resultExpiresAt"] > window.value.resultExpiresAt ||
        input["resultExpiresAt"] > input["expiresAt"]
      ) {
        return err({ code: "invalid_data", field: "job.result" });
      }
    }
    return ok(
      Object.freeze({
        id: input["id"],
        accessKeyDigest: input["accessKeyDigest"],
        inputDigest: input["inputDigest"],
        input: parsedInput.value,
        state: input["state"],
        revision: input["revision"],
        stage: input["stage"],
        progress: Object.freeze({ ...input["progress"] }),
        expiresAt: input["expiresAt"],
        resultExpiresAt: input["resultExpiresAt"],
        result: input["result"],
        error: error === null ? null : Object.freeze({ code: error.code }),
        workerId: input["workerId"],
        workerLeaseUntil: input["workerLeaseUntil"],
      }),
    );
  },
});
export function comparisonJobExpired(job: ComparisonJobRecord, now: Instant): boolean {
  return (
    job.expiresAt <= valueOf(now) ||
    (job.state === "succeeded" && job.resultExpiresAt <= valueOf(now))
  );
}
export function initialComparisonJobRecord(input: ComparisonJobCreateInput): ComparisonJobRecord {
  return Object.freeze({
    ...input,
    state: "queued",
    revision: 1,
    stage: "queued",
    progress: Object.freeze({ pages: 0, examined: 0 }),
    resultExpiresAt: input.expiresAt,
    result: null,
    error: null,
    workerId: null,
    workerLeaseUntil: null,
  });
}
export function comparisonJobCreateExisting(
  job: ComparisonJobRecord,
  input: ComparisonJobCreateInput,
  now: Instant,
): Result<ComparisonJobCreateResult, ComparisonJobStoreError> {
  if (job.accessKeyDigest !== input.accessKeyDigest) {
    return err({ code: "job_forbidden" });
  }
  if (job.inputDigest !== input.inputDigest) {
    return err({ code: "idempotency_conflict" });
  }
  if (comparisonJobExpired(job, now)) {
    return err({ code: "job_expired" });
  }
  return ok(Object.freeze({ record: job, created: false }));
}
export async function authorizeComparisonJob(
  job: ComparisonJobRecord,
  accessKey: string,
  now: Instant,
): Promise<Result<ComparisonJobRecord, ComparisonJobStoreError>> {
  if (!(await comparisonJobAccessKeyMatches(job.accessKeyDigest, accessKey))) {
    return err({ code: "job_forbidden" });
  }
  return comparisonJobExpired(job, now) ? err({ code: "job_expired" }) : ok(job);
}
export function cancelComparisonJobRecord(job: ComparisonJobRecord): ComparisonJobRecord {
  return job.state !== "queued" && job.state !== "running"
    ? job
    : Object.freeze({
        ...job,
        state: "cancelled",
        revision: job.revision + 1,
        stage: "cancelled",
        result: null,
        error: null,
        workerId: null,
        workerLeaseUntil: null,
      });
}
export function claimComparisonJobRecord(
  job: ComparisonJobRecord,
  workerId: string,
  leaseUntil: string,
  now: Instant,
): Result<ComparisonJobRecord, ComparisonJobStoreError> {
  if (comparisonJobExpired(job, now)) {
    return err({ code: "job_expired" });
  }
  if (job.state !== "queued" && job.state !== "running") {
    return err({ code: "job_terminal" });
  }
  if (
    job.state === "running" &&
    job.workerLeaseUntil !== null &&
    job.workerLeaseUntil > valueOf(now)
  ) {
    return err({ code: "job_not_claimable" });
  }
  if (!validInstant(leaseUntil) || leaseUntil <= valueOf(now)) {
    return err({ code: "job_not_claimable" });
  }
  return ok(
    Object.freeze({
      ...job,
      state: "running",
      revision: job.revision + 1,
      stage: "running",
      workerId,
      workerLeaseUntil: leaseUntil,
    }),
  );
}
function ownedJob(
  job: ComparisonJobRecord,
  workerId: string,
  revision: number,
  now: Instant,
): Result<ComparisonJobRecord, ComparisonJobStoreError> {
  if (comparisonJobExpired(job, now)) {
    return err({ code: "job_expired" });
  }
  if (job.state !== "running") {
    return err({ code: "job_terminal" });
  }
  if (
    job.workerId !== workerId ||
    job.revision !== revision ||
    job.workerLeaseUntil === null ||
    job.workerLeaseUntil <= valueOf(now)
  ) {
    return err({ code: "revision_conflict" });
  }
  return ok(job);
}
export function progressComparisonJobRecord(
  job: ComparisonJobRecord,
  workerId: string,
  revision: number,
  update: Readonly<{ stage: string; progress: ComparisonJobProgress }>,
  now: Instant,
): Result<ComparisonJobRecord, ComparisonJobStoreError> {
  const owned = ownedJob(job, workerId, revision, now);
  if (owned.tag === "err") {
    return owned;
  }
  if (update.stage.length > 64 || !validProgress(update.progress)) {
    return err({ code: "storage_unavailable" });
  }
  return ok(
    Object.freeze({
      ...job,
      revision: job.revision + 1,
      stage: update.stage,
      progress: Object.freeze({
        pages: Math.max(job.progress.pages, update.progress.pages),
        examined: Math.max(job.progress.examined, update.progress.examined),
      }),
    }),
  );
}
function resultWindow(
  result: unknown,
  now: Instant,
): Result<
  Readonly<{ resultExpiresAt: string; storageExpiresAt: string | null }>,
  Readonly<{ code: string }>
> {
  if (!record(result) || !boundedJson(result, comparisonJobMaxSerializedResultBytes)) {
    return err({ code: "invalid_result" });
  }
  let earliest = Date.parse(valueOf(now)) + comparisonJobResultLifetimeMs;
  let invalid = false;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) {
      invalid = true;
    } else if (Array.isArray(value)) {
      const entries: readonly unknown[] = value;
      entries.forEach((entry) => {
        visit(entry, depth + 1);
      });
    } else if (record(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "expiresAt") {
          if (!validInstant(entry)) {
            invalid = true;
          } else {
            earliest = Math.min(earliest, Date.parse(entry));
          }
        } else {
          visit(entry, depth + 1);
        }
      }
    }
  };
  visit(result, 0);
  const storage = result["storageExpiresAt"] ?? null;
  if (storage !== null && !validInstant(storage)) {
    invalid = true;
  }
  if (typeof storage === "string") {
    earliest = Math.min(earliest, Date.parse(storage));
  }
  return invalid || earliest <= Date.parse(valueOf(now))
    ? err({ code: "source_not_authorized" })
    : ok(
        Object.freeze({
          resultExpiresAt: new Date(earliest).toISOString(),
          storageExpiresAt: typeof storage === "string" ? storage : null,
        }),
      );
}
export function finishComparisonJobRecord(
  job: ComparisonJobRecord,
  workerId: string,
  revision: number,
  outcome: ComparisonJobOutcome,
  now: Instant,
  persistentResults: boolean,
): Result<ComparisonJobRecord, ComparisonJobStoreError> {
  if (job.state === "cancelled" || job.state === "succeeded" || job.state === "failed") {
    return ok(job);
  }
  const owned = ownedJob(job, workerId, revision, now);
  if (owned.tag === "err") {
    return owned;
  }
  const terminal = { ...job, revision: job.revision + 1, workerId: null, workerLeaseUntil: null };
  if (outcome.kind === "failed") {
    return ok(
      Object.freeze({
        ...terminal,
        state: "failed",
        stage: "failed",
        result: null,
        error: outcome.error,
      }),
    );
  }
  const window = resultWindow(outcome.result, now);
  if (
    window.tag === "err" ||
    !validInstant(outcome.resultExpiresAt) ||
    (persistentResults &&
      (outcome.storageExpiresAt === null ||
        !validInstant(outcome.storageExpiresAt) ||
        outcome.storageExpiresAt <= valueOf(now) ||
        window.value.storageExpiresAt !== outcome.storageExpiresAt))
  ) {
    return ok(
      Object.freeze({
        ...terminal,
        state: "failed",
        stage: "failed",
        result: null,
        error: Object.freeze({
          code: window.tag === "err" ? window.error.code : "result_storage_denied",
        }),
      }),
    );
  }
  return ok(
    Object.freeze({
      ...terminal,
      state: "succeeded",
      stage: "succeeded",
      result: outcome.result,
      error: null,
      resultExpiresAt: new Date(
        Math.min(
          Date.parse(job.expiresAt),
          Date.parse(window.value.resultExpiresAt),
          Date.parse(outcome.resultExpiresAt),
        ),
      ).toISOString(),
    }),
  );
}
export function toComparisonJobSnapshot(
  job: ComparisonJobRecord,
  accessKey: string,
  now: Instant,
): ComparisonJobSnapshot {
  return Object.freeze({ ...toComparisonJobPublicSnapshot(job, now), accessKey });
}
export function toComparisonJobPublicSnapshot(
  job: ComparisonJobRecord,
  now: Instant,
): ComparisonJobPublicSnapshot {
  return Object.freeze({
    id: job.id,
    state: job.state,
    revision: job.revision,
    stage: job.stage,
    progress: job.progress,
    expiresAt: job.state === "succeeded" ? job.resultExpiresAt : job.expiresAt,
    ...(job.state === "succeeded" && !comparisonJobExpired(job, now) && job.result !== null
      ? { result: job.result }
      : {}),
    ...(job.state === "failed" && job.error !== null ? { error: job.error } : {}),
  });
}
export async function startComparisonJob(
  store: ComparisonJobStore,
  input: ComparisonJobInput,
  idempotencyKey: string,
  accessKey: string,
  now: Instant,
): Promise<Result<ComparisonJobCreateResult, ComparisonJobStoreError>> {
  const [id, accessKeyDigest, inputDigest] = await Promise.all([
    digest(idempotencyKey),
    digestComparisonJobAccessKey(accessKey),
    digestComparisonJobInput(input),
  ]);
  return await store.create(
    Object.freeze({
      id,
      input,
      accessKeyDigest,
      inputDigest,
      expiresAt: new Date(Date.parse(valueOf(now)) + comparisonJobMetadataLifetimeMs).toISOString(),
    }),
  );
}
function waitUntilStopped(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(stop, delay);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }
  });
}
async function untilAborted<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value | null> {
  const handled = work.then(
    (value) => value,
    () => null,
  );
  let stop: () => void = () => undefined;
  const aborted = new Promise<null>((resolve) => {
    stop = (): void => {
      resolve(null);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }
  });
  try {
    return await Promise.race([handled, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}
export async function runComparisonJob(
  store: ComparisonJobStore,
  runner: ConsumerComparisonRunner,
  jobId: string,
  workerId: string,
  now: () => Instant,
  options: Readonly<{
    deadlineMs?: number;
    watchIntervalMs?: number;
    finishDeadlineMs?: number;
  }> = {},
): Promise<void> {
  const abort = new AbortController();
  const deadline = setTimeout(() => {
    abort.abort();
  }, options.deadlineMs ?? 40_000);
  const claimed = await untilAborted(
    store.claim(
      jobId,
      workerId,
      new Date(Date.parse(valueOf(now())) + comparisonJobWorkerLeaseMs).toISOString(),
    ),
    abort.signal,
  );
  if (claimed === null || claimed.tag === "err") {
    clearTimeout(deadline);
    return;
  }
  let revision = claimed.value.revision;
  let failure = "job_deadline";
  const stopWatch = new AbortController();
  const watchSignal = AbortSignal.any([stopWatch.signal, abort.signal]);
  let progressWork = Promise.resolve();
  const stopped = (): boolean => stopWatch.signal.aborted || abort.signal.aborted;
  const watch = async (): Promise<void> => {
    try {
      while (!stopped()) {
        await waitUntilStopped(watchSignal, options.watchIntervalMs ?? 250);
        if (stopped()) {
          break;
        }
        const latest = await untilAborted(store.read(jobId), watchSignal);
        if (latest === null && stopped()) {
          break;
        }
        if (latest === null || latest.tag === "err" || latest.value === null) {
          failure = "storage_unavailable";
          abort.abort();
        } else if (
          latest.value.state !== "running" ||
          latest.value.workerId !== workerId ||
          latest.value.workerLeaseUntil !== claimed.value.workerLeaseUntil ||
          comparisonJobExpired(latest.value, now()) ||
          latest.value.workerLeaseUntil === null ||
          latest.value.workerLeaseUntil <= valueOf(now())
        ) {
          failure = "job_ownership_lost";
          abort.abort();
        }
      }
    } catch {
      failure = "storage_unavailable";
      abort.abort();
    }
  };
  const watching = watch();
  const persist = async (outcome: ComparisonJobOutcome): Promise<void> => {
    const finishAbort = new AbortController();
    const timer = setTimeout(() => {
      finishAbort.abort();
    }, options.finishDeadlineMs ?? 5_000);
    try {
      const finished = await untilAborted(
        store.finish(jobId, workerId, revision, outcome),
        finishAbort.signal,
      );
      if (finished?.tag === "err" && finished.error.code === "revision_conflict") {
        const latest = await untilAborted(store.read(jobId), finishAbort.signal);
        if (
          latest?.tag === "ok" &&
          latest.value !== null &&
          latest.value.state === "running" &&
          latest.value.workerId === workerId &&
          latest.value.workerLeaseUntil === claimed.value.workerLeaseUntil
        ) {
          await untilAborted(
            store.finish(jobId, workerId, latest.value.revision, outcome),
            finishAbort.signal,
          );
        }
      }
    } finally {
      clearTimeout(timer);
      finishAbort.abort();
    }
  };
  try {
    const comparison = Promise.resolve()
      .then(
        async () =>
          await runner.compare(claimed.value.input, {
            signal: abort.signal,
            onProgress: (progress): Promise<void> => {
              const update = progressWork.then(async () => {
                if (abort.signal.aborted) {
                  return;
                }
                const updated = await untilAborted(
                  store.progress(jobId, workerId, revision, {
                    stage: progress.stage,
                    progress: { pages: progress.pages, examined: progress.examined },
                  }),
                  abort.signal,
                );
                if (updated === null && stopped()) {
                  return;
                }
                if (updated === null || updated.tag === "err") {
                  failure = "job_ownership_lost";
                  abort.abort();
                } else {
                  revision = updated.value.revision;
                }
              });
              progressWork = update;
              return update;
            },
          }),
      )
      .catch(() => err({ code: "comparison_failed" }));
    const compared = await untilAborted(comparison, abort.signal);
    await progressWork;
    const outcome = compared === null || abort.signal.aborted ? err({ code: failure }) : compared;
    if (failure === "job_ownership_lost" && abort.signal.aborted) {
      return;
    }
    const window = outcome.tag === "ok" ? resultWindow(outcome.value, now()) : null;
    await persist(
      outcome.tag === "ok" && window?.tag === "ok"
        ? { kind: "succeeded", result: outcome.value, ...window.value }
        : {
            kind: "failed",
            error: {
              code:
                outcome.tag === "err"
                  ? outcome.error.code
                  : window?.tag === "err"
                    ? window.error.code
                    : "invalid_result",
            },
          },
    );
  } catch {
    await persist({ kind: "failed", error: { code: "comparison_failed" } });
  } finally {
    clearTimeout(deadline);
    abort.abort();
    stopWatch.abort();
    await watching;
  }
}
