import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";

import {
  startComparisonJob,
  runComparisonJob,
} from "../packages/backend/dist/comparison/consumer-jobs.js";
import { instant } from "../packages/backend/dist/comparison/values.js";
import { createXserverBridge } from "../packages/backend/dist/infrastructure/xserver/bridge.js";
import { createXserverComparisonJobStore } from "../packages/backend/dist/infrastructure/xserver/jobs.js";

assert.match(process.env.COMPARE_TEST_DSN ?? "", /dbname=compare_test_[a-zA-Z0-9_]+/);
const php = process.env.PHP_BINARY ?? "php";
const extensionDirectory = process.env.COMPARE_TEST_PHP_EXTENSION_DIR;
const phpOptions =
  extensionDirectory === undefined
    ? []
    : ["-n", "-d", `extension_dir=${extensionDirectory}`, "-d", "extension=pdo_mysql"];
async function transport(endpoint, options) {
  assert.equal(options.redirect, "error");
  const payload = JSON.stringify({
    path: endpoint.pathname,
    headers: options.headers,
    body: options.body,
  });
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      "rtk",
      ["proxy", php, ...phpOptions, "apps/storage-bridge/tests/transport.php"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PHP transport deadline"));
    }, 5000);
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 650000) {
        child.kill();
        reject(new Error("PHP response exceeds limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("PHP transport unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("PHP transport failed"));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    child.stdin.on("error", () => {
      reject(new Error("PHP input unavailable"));
    });
    child.stdin.end(payload);
  });
  return new globalThis.Response(output, { headers: { "content-type": "application/json" } });
}
const bridge = createXserverBridge(
  { url: "https://storage.example/compare-storage/index.php", secret: "a".repeat(64) },
  transport,
);
const clock = () => {
  const value = instant(new Date().toISOString());
  assert.equal(value.tag, "ok");
  return value.value;
};
const store = createXserverComparisonJobStore(bridge, clock);
const input = {
  url: "https://example.test/source",
  keyword: "日本語の検証",
  category: "laptop",
  conditions: {},
  sort: "price",
};
const key = "k".repeat(36);
const operation = randomUUID();
const accepted = await Promise.all([
  startComparisonJob(store, input, operation, key, clock()),
  startComparisonJob(store, input, operation, key, clock()),
]);
for (const result of accepted) {
  assert.equal(result.tag, "ok");
}
assert.equal(accepted.filter((result) => result.value.created).length, 1);
const id = accepted[0].value.record.id;
assert.deepEqual(await store.readAuthorized(id, "wrong"), {
  tag: "err",
  error: { code: "job_forbidden" },
});
const leases = await Promise.all([
  store.claim(id, "worker-a", new Date(Date.now() + 45000).toISOString()),
  store.claim(id, "worker-b", new Date(Date.now() + 45000).toISOString()),
]);
assert.equal(leases.filter((result) => result.tag === "ok").length, 1);
const winner = leases.find((result) => result.tag === "ok").value;
const progressed = await store.progress(id, winner.workerId, winner.revision, {
  stage: "search",
  progress: { pages: 1, examined: 3 },
});
assert.equal(progressed.tag, "ok");
assert.equal(
  (
    await store.progress(id, winner.workerId, winner.revision, {
      stage: "stale",
      progress: { pages: 0, examined: 0 },
    })
  ).tag,
  "err",
);
const finished = await store.finish(id, winner.workerId, progressed.value.revision, {
  kind: "failed",
  error: { code: "provider_unavailable" },
});
assert.equal(finished.tag, "ok");
let comparisons = 0;
await runComparisonJob(
  store,
  {
    compare: async () => {
      comparisons++;
      return { tag: "err", error: { code: "unexpected" } };
    },
  },
  id,
  "duplicate-delivery",
  clock,
);
assert.equal(comparisons, 0);
const snapshot = await store.readAuthorized(id, key);
assert.equal(snapshot.tag, "ok");
assert.equal(snapshot.value.state, "failed");
assert.equal(snapshot.value.input.conditions.constructor, Object);
assert.equal(snapshot.value.input.keyword, "日本語の検証");
console.log(
  "TypeScript -> signed PHP -> real MariaDB: concurrent create, claim fencing, progress, finish and duplicate delivery passed.",
);
