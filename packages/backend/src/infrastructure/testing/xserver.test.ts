import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  comparisonJobRecordSchema,
  digestComparisonJobAccessKey,
  startComparisonJob,
} from "../../comparison/consumer-jobs.js";
import type { ComparisonJobInput, ComparisonJobRecord } from "../../comparison/consumer-jobs.js";
import { instant, record } from "../../comparison/values.js";
import { createXserverBridge } from "../xserver/bridge.js";
import type { XserverBridge } from "../xserver/bridge.js";
import { createXserverComparisonJobStore } from "../xserver/jobs.js";

await test("bridge authenticates the exact bytes and path and refuses redirects and oversized replies", async () => {
  const secret = "a".repeat(64);
  const configuration = { url: "https://storage.example/compare-storage/index.php", secret };
  let nonce = "";
  const bridge = createXserverBridge(configuration, async (url, options) => {
    assert.ok(url instanceof URL);
    assert.equal(url.href, configuration.url);
    assert.ok(options !== undefined && typeof options.body === "string");
    assert.equal(options.redirect, "error");
    const headers = new Headers(options.headers);
    const timestamp = headers.get("x-bridge-time");
    assert.ok(timestamp !== null);
    const currentNonce = headers.get("x-bridge-nonce");
    assert.ok(currentNonce !== null && currentNonce !== nonce);
    nonce = currentNonce;
    assert.equal(
      headers.get("x-bridge-signature"),
      createHmac("sha256", secret)
        .update(`${timestamp}\n${nonce}\n/compare-storage/index.php\n${options.body}`)
        .digest("hex"),
    );
    await Promise.resolve();
    return new Response(JSON.stringify({ ok: true, value: null }));
  });
  await bridge("read", { id: "a".repeat(64) });
  await bridge("read", { id: "a".repeat(64) });
  for (const url of [
    "http://storage.example/",
    "https://user:password@storage.example/",
    "https://127.0.0.1/",
    "https://storage.example/?token=private",
  ]) {
    assert.throws(() => createXserverBridge({ ...configuration, url }));
  }
  const oversized = createXserverBridge(configuration, () =>
    Promise.resolve(new Response(" ".repeat(650001))),
  );
  await assert.rejects(oversized("read", {}));
  const unavailable = createXserverBridge(configuration, () =>
    Promise.resolve(new Response("private", { status: 503 })),
  );
  await assert.rejects(unavailable("read", {}), /Storage unavailable/);
});

await test("persistent HTTP store fences concurrent workers and preserves access and idempotency checks", async () => {
  const parsedTime = instant("2026-10-21T12:00:00.000Z");
  assert.equal(parsedTime.tag, "ok");
  const clock = () => parsedTime.value;
  const records = new Map<string, ComparisonJobRecord>();
  const bridge: XserverBridge = async (operation, input) => {
    await Promise.resolve();
    assert.ok(record(input));
    if (operation === "read") {
      const id = input["id"];
      assert.ok(typeof id === "string");
      return records.get(id) ?? null;
    }
    const parsed = comparisonJobRecordSchema.parse(input["record"]);
    assert.equal(parsed.tag, "ok");
    const job = parsed.value;
    if (operation === "create") {
      const previous = records.get(job.id);
      if (previous !== undefined) {
        return { created: false, record: previous };
      }
      records.set(job.id, job);
      return { created: true, record: job };
    }
    assert.equal(operation, "replace");
    if (records.get(job.id)?.revision !== input["revision"]) {
      return false;
    }
    records.set(job.id, job);
    return true;
  };
  const store = createXserverComparisonJobStore(bridge, clock);
  const input: ComparisonJobInput = {
    url: "https://example.test/source",
    category: "laptop",
    keyword: null,
    conditions: {},
    sort: "price",
  };
  const key = "k".repeat(36);
  const created = await startComparisonJob(store, input, "operation", key, clock());
  assert.equal(created.tag, "ok");
  const id = created.value.record.id;
  const duplicate = await startComparisonJob(store, input, "operation", key, clock());
  assert.equal(duplicate.tag, "ok");
  assert.equal(duplicate.value.created, false);
  assert.deepEqual(await store.readAuthorized(id, "wrong"), {
    tag: "err",
    error: { code: "job_forbidden" },
  });
  const claims = await Promise.all([
    store.claim(id, "worker-a", "2026-10-21T12:00:45.000Z"),
    store.claim(id, "worker-b", "2026-10-21T12:00:45.000Z"),
  ]);
  assert.equal(claims.filter((value) => value.tag === "ok").length, 1);
  const claimed = claims.find((value) => value.tag === "ok");
  assert.ok(claimed !== undefined);
  assert.equal(claimed.value.accessKeyDigest, await digestComparisonJobAccessKey(key));
  assert.deepEqual(
    await store.progress(id, "stale-worker", claimed.value.revision, {
      stage: "search",
      progress: { pages: 1, examined: 1 },
    }),
    { tag: "err", error: { code: "revision_conflict" } },
  );
  const unavailable = createXserverComparisonJobStore(
    () => Promise.reject(new Error("private")),
    clock,
  );
  assert.deepEqual(await unavailable.read(id), {
    tag: "err",
    error: { code: "storage_unavailable" },
  });
});
