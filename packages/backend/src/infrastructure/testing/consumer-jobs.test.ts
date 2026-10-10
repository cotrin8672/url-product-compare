import assert from "node:assert/strict";
import { test } from "node:test";

import { err, ok } from "../../comparison/algebra.js";
import {
  cancelComparisonJobRecord,
  claimComparisonJobRecord,
  comparisonJobRecordSchema,
  digestComparisonJobAccessKey,
  digestComparisonJobInput,
  finishComparisonJobRecord,
  initialComparisonJobRecord,
  progressComparisonJobRecord,
  runComparisonJob,
} from "../../comparison/consumer-jobs.js";
import type {
  ComparisonJobInput,
  ComparisonJobRecord,
  ComparisonJobStore,
  ConsumerComparisonRunner,
} from "../../comparison/consumer-jobs.js";
import { instant } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

function at(value: string): Instant {
  const parsed = instant(value);
  if (parsed.tag === "err") {
    throw new Error("Invalid test instant");
  }
  return parsed.value;
}
const now = at("2026-10-06T12:00:00.000Z");
const input: ComparisonJobInput = {
  url: "https://example.test/source",
  keyword: null,
  category: "laptop",
  conditions: { ramGb: 16, storageGb: 512 },
  sort: "price",
};
async function queued(): Promise<ComparisonJobRecord> {
  return initialComparisonJobRecord({
    id: "a".repeat(64),
    input,
    inputDigest: await digestComparisonJobInput(input),
    accessKeyDigest: await digestComparisonJobAccessKey("k".repeat(36)),
    expiresAt: "2026-10-06T13:00:00.000Z",
  });
}
function gate(): Readonly<{ wait: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlledStore(
  initial: ComparisonJobRecord,
  hooks: Readonly<{ read?: () => Promise<void>; progressReply?: () => Promise<void> }> = {},
): Readonly<{ store: ComparisonJobStore; current: () => ComparisonJobRecord }> {
  let current = initial;
  const store: ComparisonJobStore = {
    persistentResults: false,
    create: () => Promise.resolve(ok({ record: current, created: false })),
    read: async () => {
      await hooks.read?.();
      return ok(current);
    },
    readAuthorized: () => Promise.resolve(ok(current)),
    cancel: () => Promise.resolve(err({ code: "job_forbidden" })),
    claim: (_id, worker, until) => {
      const next = claimComparisonJobRecord(current, worker, until, now);
      if (next.tag === "ok") {
        current = next.value;
      }
      return Promise.resolve(next);
    },
    progress: async (_id, worker, revision, update) => {
      const next = progressComparisonJobRecord(current, worker, revision, update, now);
      if (next.tag === "ok") {
        current = next.value;
      }
      await hooks.progressReply?.();
      return next;
    },
    finish: (_id, worker, revision, outcome) => {
      const next = finishComparisonJobRecord(current, worker, revision, outcome, now, false);
      if (next.tag === "ok") {
        current = next.value;
      }
      return Promise.resolve(next);
    },
  };
  return { store, current: () => current };
}
await test("watcher tolerates its own committed progress while the transaction reply is delayed", async () => {
  const delayed = gate();
  const committed = gate();
  const observed = gate();
  let progressCommitted = false;
  const harness = controlledStore(await queued(), {
    progressReply: async () => {
      progressCommitted = true;
      committed.release();
      await delayed.wait;
    },
    read: () => {
      if (progressCommitted) {
        observed.release();
      }
      return Promise.resolve();
    },
  });
  let unexpectedAbort = false;
  const runner: ConsumerComparisonRunner = {
    compare: async (_input, options) => {
      await options.onProgress({ stage: "search", pages: 1, examined: 6 });
      unexpectedAbort = options.signal.aborted;
      return ok({ products: [], storageExpiresAt: null });
    },
  };
  const work = runComparisonJob(harness.store, runner, harness.current().id, "worker", () => now, {
    watchIntervalMs: 2,
    deadlineMs: 500,
  });
  await committed.wait;
  await observed.wait;
  delayed.release();
  await work;
  assert.equal(unexpectedAbort, false);
  assert.equal(harness.current().state, "succeeded");
});
await test("runner deadline bounds stalled reads and progress replies without late state mutation", async () => {
  for (const stalled of ["read", "progress"]) {
    const delay = gate();
    const harness = controlledStore(
      await queued(),
      stalled === "read" ? { read: () => delay.wait } : { progressReply: () => delay.wait },
    );
    const runner: ConsumerComparisonRunner = {
      compare: async (_input, options) => {
        if (stalled === "progress") {
          await options.onProgress({ stage: "search", pages: 1, examined: 2 });
        }
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        return err({ code: "aborted" });
      },
    };
    const started = Date.now();
    await runComparisonJob(harness.store, runner, harness.current().id, "worker", () => now, {
      watchIntervalMs: 1,
      deadlineMs: 10,
      finishDeadlineMs: 50,
    });
    assert.ok(Date.now() - started < 500, "A stalled store call exceeded the runner deadline");
    assert.equal(harness.current().state, "failed");
    assert.equal(harness.current().error?.code, "job_deadline");
    const finished = harness.current();
    delay.release();
    await Promise.resolve();
    assert.deepEqual(harness.current(), finished);
  }
});
await test("job fingerprints canonicalize conditions and documents validate external unknown", async () => {
  assert.equal(
    await digestComparisonJobInput(input),
    await digestComparisonJobInput({ ...input, conditions: { storageGb: 512, ramGb: 16 } }),
  );
  const job = await queued();
  assert.equal(comparisonJobRecordSchema.parse(job).tag, "ok");
  for (const invalid of [
    null,
    { ...job, expiresAt: "2026-02-30T12:00:00.000Z" },
    { ...job, revision: 1.5 },
    { ...job, input: { ...input, sort: "other" } },
    { ...job, result: "x".repeat(512_001) },
  ]) {
    assert.equal(comparisonJobRecordSchema.parse(invalid).tag, "err");
  }
});
await test("active claims reject repeated same worker and takeover fences old progress and finish", async () => {
  const claimed = claimComparisonJobRecord(
    await queued(),
    "worker",
    "2026-10-06T12:00:45.000Z",
    now,
  );
  assert.equal(claimed.tag, "ok");
  for (const worker of ["worker", "other"]) {
    assert.deepEqual(
      claimComparisonJobRecord(claimed.value, worker, "2026-10-06T12:00:45.000Z", now),
      { tag: "err", error: { code: "job_not_claimable" } },
    );
  }
  const later = at("2026-10-06T12:00:46.000Z");
  const taken = claimComparisonJobRecord(claimed.value, "other", "2026-10-06T12:01:30.000Z", later);
  assert.equal(taken.tag, "ok");
  const update = { stage: "search", progress: { pages: 1, examined: 6 } };
  assert.equal(
    progressComparisonJobRecord(taken.value, "worker", claimed.value.revision, update, later).tag,
    "err",
  );
  assert.equal(
    finishComparisonJobRecord(
      taken.value,
      "worker",
      claimed.value.revision,
      { kind: "failed", error: { code: "old" } },
      later,
      false,
    ).tag,
    "err",
  );
  const progressed = progressComparisonJobRecord(
    taken.value,
    "other",
    taken.value.revision,
    update,
    later,
  );
  assert.equal(progressed.tag, "ok");
  assert.equal(progressed.value.revision, taken.value.revision + 1);
});
await test("cancel and terminal progress cannot overwrite a finished result", async () => {
  const claimed = claimComparisonJobRecord(
    await queued(),
    "worker",
    "2026-10-06T12:00:45.000Z",
    now,
  );
  if (claimed.tag === "err") {
    throw new Error("Claim failed");
  }
  const success = {
    kind: "succeeded",
    result: {
      source: { expiresAt: "2026-10-06T12:05:00.000Z" },
      products: [],
      storageExpiresAt: null,
    },
    resultExpiresAt: "2026-10-06T12:15:00.000Z",
    storageExpiresAt: null,
  } satisfies Parameters<typeof finishComparisonJobRecord>[3];
  const cancelled = cancelComparisonJobRecord(claimed.value);
  assert.deepEqual(
    finishComparisonJobRecord(cancelled, "worker", claimed.value.revision, success, now, false),
    { tag: "ok", value: cancelled },
  );
  const finished = finishComparisonJobRecord(
    claimed.value,
    "worker",
    claimed.value.revision,
    success,
    now,
    false,
  );
  if (finished.tag === "err") {
    throw new Error("Finish failed");
  }
  assert.equal(cancelComparisonJobRecord(finished.value).state, "succeeded");
  for (const terminal of [
    cancelled,
    finished.value,
    { ...finished.value, state: "failed" } satisfies ComparisonJobRecord,
  ]) {
    assert.equal(
      progressComparisonJobRecord(
        terminal,
        "worker",
        terminal.revision,
        { stage: "late", progress: { pages: 8, examined: 48 } },
        now,
      ).tag,
      "err",
    );
  }
  assert.equal(
    progressComparisonJobRecord(
      claimed.value,
      "worker",
      claimed.value.revision,
      { stage: "late", progress: { pages: 1, examined: 2 } },
      at("2026-10-06T13:00:01.000Z"),
    ).tag,
    "err",
  );
  assert.equal(finished.value.resultExpiresAt, "2026-10-06T12:05:00.000Z");
});
await test("durable results require explicit storage grant and earliest source, product and grant expiry", async () => {
  const claimed = claimComparisonJobRecord(
    await queued(),
    "worker",
    "2026-10-06T12:00:45.000Z",
    now,
  );
  if (claimed.tag === "err") {
    throw new Error("Claim failed");
  }
  const result = {
    source: { expiresAt: "2026-10-06T12:09:00.000Z" },
    products: [{ expiresAt: "2026-10-06T12:03:00.000Z" }],
    storageExpiresAt: "2026-10-06T12:04:00.000Z",
  };
  const outcome = {
    kind: "succeeded",
    result,
    resultExpiresAt: "2026-10-06T12:15:00.000Z",
    storageExpiresAt: result.storageExpiresAt,
  } satisfies Parameters<typeof finishComparisonJobRecord>[3];
  const allowed = finishComparisonJobRecord(
    claimed.value,
    "worker",
    claimed.value.revision,
    outcome,
    now,
    true,
  );
  assert.equal(allowed.tag, "ok");
  assert.equal(allowed.value.state, "succeeded");
  assert.equal(allowed.value.resultExpiresAt, "2026-10-06T12:03:00.000Z");
  const denied = finishComparisonJobRecord(
    claimed.value,
    "worker",
    claimed.value.revision,
    { ...outcome, result: { ...result, storageExpiresAt: null }, storageExpiresAt: null },
    now,
    true,
  );
  assert.equal(denied.tag, "ok");
  assert.equal(denied.value.state, "failed");
  assert.equal(denied.value.error?.code, "result_storage_denied");
  assert.equal(denied.value.result, null);
  const malformed = finishComparisonJobRecord(
    claimed.value,
    "worker",
    claimed.value.revision,
    { ...outcome, result: { ...result, source: { expiresAt: "invalid" } } },
    now,
    true,
  );
  assert.equal(malformed.tag, "ok");
  assert.equal(malformed.value.state, "failed");
});
