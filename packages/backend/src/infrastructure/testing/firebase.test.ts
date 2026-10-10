import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createApiHandler,
  createPublicConsumerApi,
  rankDemoWithJev,
  readPublicAsset,
} from "../../bootstrap.js";
import { err, ok } from "../../comparison/algebra.js";
import {
  digestComparisonJobAccessKey,
  runComparisonJob,
  startComparisonJob,
} from "../../comparison/consumer-jobs.js";
import type {
  ComparisonJobInput,
  ComparisonJobStore,
  ConsumerComparisonRunner,
} from "../../comparison/consumer-jobs.js";
import { createConsumerComparisonService } from "../../comparison/consumer-service.js";
import { consumerCategories } from "../../comparison/consumer.js";
import { instant, record } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import { createFirestoreRunStore } from "../firebase/firestore.js";
import { apiResponse, parseApiRequest } from "../http/request.js";
import { createMemoryComparisonJobStore } from "../jobs/memory.js";

await test("public assets serve built pages and reject private files, traversal and escaped symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compare-static-"));
  const root = join(directory, "public");
  try {
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(join(root, "category", "laptop"), { recursive: true });
    await mkdir(join(directory, "private"));
    await writeFile(join(root, "index.html"), "<html>App</html>");
    await writeFile(join(root, "category", "laptop", "index.html"), "<html>Laptops</html>");
    await writeFile(join(root, "assets", "app.js"), "export const app = true;");
    await writeFile(join(root, ".env"), "SECRET=private");
    await writeFile(join(directory, "private", "secret.txt"), "private");
    await symlink(join(directory, "private"), join(root, "escape"), "junction");

    const page = await readPublicAsset(root, "/", "GET");
    assert.equal(page.statusCode, 200);
    assert.equal(page.body.toString(), "<html>App</html>");
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(
      (await readPublicAsset(root, "/category/laptop/", "GET")).body.toString(),
      "<html>Laptops</html>",
    );
    assert.equal(
      (await readPublicAsset(root, "/compare/laptop/", "GET")).body.toString(),
      page.body.toString(),
    );
    const script = await readPublicAsset(root, "/assets/app.js", "GET");
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
    const head = await readPublicAsset(root, "/assets/app.js", "HEAD");
    assert.equal(head.body.byteLength, 0);
    assert.equal(head.headers["content-length"], String(script.body.byteLength));
    for (const pathname of [
      "/.env",
      "/%2eenv",
      "/%2e%2e/private/secret.txt",
      "/assets%5c..%5c.env",
      "/escape/secret.txt",
      "/assets/missing.js",
      "/source.ts",
    ]) {
      assert.equal((await readPublicAsset(root, pathname, "GET")).statusCode, 404, pathname);
    }
    assert.equal((await readPublicAsset(root, "/%zz", "GET")).statusCode, 400);
    assert.equal((await readPublicAsset(root, "/", "POST")).statusCode, 405);
  } finally {
    // directory is the absolute temporary directory created by mkdtemp above.
    await rm(directory, { recursive: true });
  }
});

function jobClock(): Readonly<{ clock: () => Instant; advance: (ms: number) => void }> {
  let timestamp = Date.parse("2026-10-06T12:00:00.000Z");
  return {
    clock: () => {
      const parsed = instant(new Date(timestamp).toISOString());
      if (parsed.tag === "err") {
        throw new Error("Invalid test clock");
      }
      return parsed.value;
    },
    advance: (ms) => {
      timestamp += ms;
    },
  };
}
function barrier(): Readonly<{ wait: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function fastResponse<Value>(work: Promise<Value>, release: () => void): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      release();
      reject(new Error("POST awaited the blocked runner"));
    }, 500);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
const jobInput: ComparisonJobInput = {
  url: "https://synthetic.example/source",
  keyword: null,
  category: "laptop",
  conditions: {},
  sort: "price",
};
const jobKey = "capability-123456789012345678901234567890";
async function acceptedJob(
  store: ComparisonJobStore,
  clock: () => Instant,
  id: string,
): Promise<string> {
  const accepted = await startComparisonJob(store, jobInput, id, jobKey, clock());
  assert.equal(accepted.tag, "ok");
  return accepted.value.record.id;
}
await test("public consumer entry accepts token-free jobs while preserving capability ownership and protected routes", async () => {
  const { clock } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const token = "server-only-token-123456789012345678901234567890";
  let dispatches = 0;
  const internal = createApiHandler(false, null, null, null, {
    consumerService: createConsumerComparisonService([], undefined, clock),
    jobStore: store,
    clock,
    apiAccessToken: token,
    dispatchComparisonJob: async () => {
      dispatches += 1;
      await Promise.resolve();
    },
  });
  const publicApi = createPublicConsumerApi(internal, {
    accessToken: token,
    allowedOrigin: "https://consumer.example",
  });
  const headers = { origin: "https://consumer.example", "x-comparison-key": jobKey };
  const event = {
    path: "/api/comparisons",
    method: "POST",
    headers,
    body: JSON.stringify({ ...jobInput, idempotencyKey: "public-operation" }),
  };
  assert.equal((await internal(event)).statusCode, 401);
  const accepted = await publicApi(event, "native-address");
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(accepted.headers["access-control-allow-origin"], headers.origin);
  const decoded: unknown = JSON.parse(accepted.body);
  assert.ok(
    record(decoded) && record(decoded["value"]) && typeof decoded["value"]["id"] === "string",
  );
  const id = decoded["value"]["id"];
  assert.equal(decoded["value"]["accessKey"], jobKey);
  assert.equal((await publicApi(event, "native-address")).statusCode, 200);
  assert.equal(dispatches, 1);
  const mismatched = await publicApi(
    {
      ...event,
      headers: { ...headers, "x-comparison-key": "different-key-123456789012345678901234567890" },
    },
    "native-address",
  );
  assert.equal(mismatched.statusCode, 403);
  assert.equal(mismatched.body.includes(id), false);
  const path = `/api/comparisons/${id}`;
  const read = await publicApi({ path, method: "GET", headers }, "native-address");
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.body.includes('"accessKey"'), false);
  const denied = await publicApi(
    { path, method: "GET", headers: { origin: headers.origin } },
    "native-address",
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.includes(id), false);
  assert.equal(
    (await publicApi({ ...event, path: "/api/compare" }, "native-address")).statusCode,
    401,
  );
  assert.equal(
    (await publicApi({ path: `${path}/cancel`, method: "POST", headers }, "native-address"))
      .statusCode,
    401,
  );
  assert.equal(
    (await publicApi({ path, method: "POST", headers }, "native-address")).statusCode,
    401,
  );
  for (const response of [accepted, read, denied, mismatched]) {
    assert.equal(response.body.includes(token), false);
  }
});

await test("public consumer entry only injects server authorization for exact permitted routes and checks browser origin", async () => {
  const token = "server-only-token-123456789012345678901234567890";
  const received: unknown[] = [];
  const internal = (event: unknown) => {
    received.push(event);
    return Promise.resolve(apiResponse(200, ok({ accepted: true })));
  };
  const gateway = createPublicConsumerApi(internal, {
    accessToken: token,
    allowedOrigin: "https://consumer.example",
  });
  const paths = [
    "/api/compare",
    "/api/admin",
    "/api/comparisons/short",
    `/api/comparisons/${"a".repeat(64)}/cancel`,
    "/api/detect/",
    "/api/comparisons?path=/api/admin",
  ];
  for (const path of paths) {
    const event = { path, method: "POST", headers: {}, body: "{}" };
    await gateway(event, "native-address");
    assert.deepEqual(received.at(-1), event);
  }
  const event = {
    path: "/api/detect",
    method: "POST",
    headers: {
      origin: "https://consumer.example",
      authorization: "Bearer browser-input",
      "x-comparison-key": jobKey,
    },
    body: JSON.stringify({ url: jobInput.url }),
  };
  const response = await gateway(event, "native-address");
  assert.equal(response.statusCode, 200);
  const forwarded = received.at(-1);
  assert.ok(record(forwarded) && record(forwarded["headers"]));
  assert.equal(forwarded["headers"]["authorization"], `Bearer ${token}`);
  assert.equal(forwarded["headers"]["x-comparison-key"], jobKey);
  const before = received.length;
  assert.equal(
    (await gateway({ ...event, headers: { origin: "https://foreign.example" } }, "native-address"))
      .statusCode,
    403,
  );
  assert.equal(
    (await gateway({ ...event, headers: { origin: "null" } }, "native-address")).statusCode,
    403,
  );
  assert.equal(
    (
      await gateway(
        { ...event, headers: { origin: ["https://consumer.example"] } },
        "native-address",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await gateway(
        {
          ...event,
          headers: { origin: "https://consumer.example", Origin: "https://consumer.example" },
        },
        "native-address",
      )
    ).statusCode,
    400,
  );
  assert.equal(received.length, before);
  const preflight = await gateway(
    {
      path: `/api/comparisons/${"a".repeat(64)}`,
      method: "OPTIONS",
      headers: { origin: "https://consumer.example" },
    },
    "native-address",
  );
  assert.equal(preflight.statusCode, 204);
  assert.equal(received.length, before);
  const sameOrigin = createPublicConsumerApi(internal, { accessToken: token });
  assert.equal(
    (await sameOrigin(event, "native-address", "https://consumer.example")).statusCode,
    200,
  );
  assert.equal(
    (await sameOrigin(event, "native-address", "https://different.example")).statusCode,
    403,
  );
  assert.equal((await sameOrigin({ ...event, headers: {} }, "native-address")).statusCode, 200);
  assert.throws(() =>
    createPublicConsumerApi(internal, {
      accessToken: token,
      allowedOrigin: "https://consumer.example/arbitrary-path",
    }),
  );
  assert.throws(() => createPublicConsumerApi(internal, { accessToken: "short" }));
});

await test("public consumer entry limits costly requests by trusted address and bounds memory without charging polls", async () => {
  let timestamp = 0;
  let calls = 0;
  const gateway = createPublicConsumerApi(
    () => {
      calls += 1;
      return Promise.resolve(apiResponse(200, ok({ accepted: true })));
    },
    { accessToken: "server-only-token-123456789012345678901234567890", clock: () => timestamp },
  );
  const event = {
    path: "/api/detect",
    method: "POST",
    body: JSON.stringify({ url: jobInput.url }),
    headers: {},
  };
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await gateway(event, "native-address")).statusCode, 200);
  }
  const limited = await gateway(
    { ...event, headers: { "x-forwarded-for": "different-address" } },
    "native-address",
  );
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(calls, 6);
  assert.equal(
    (
      await gateway(
        {
          path: `/api/comparisons/${"a".repeat(64)}`,
          method: "GET",
          headers: { "x-comparison-key": jobKey },
        },
        "native-address",
      )
    ).statusCode,
    200,
  );
  assert.equal((await gateway(event, "another-native-address")).statusCode, 200);
  timestamp = 60_000;
  assert.equal((await gateway(event, "native-address")).statusCode, 200);
  for (let index = 1; index < 1024; index += 1) {
    assert.equal((await gateway(event, `native-${index}`)).statusCode, 200);
  }
  assert.equal((await gateway(event, "capacity-exceeded")).statusCode, 429);
  timestamp = 120_000;
  assert.equal((await gateway(event, "capacity-exceeded")).statusCode, 200);
});

await test("comparison job atomic idempotency checks capability and input including concurrent submissions", async () => {
  const { clock } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const same = await Promise.all([
    startComparisonJob(store, jobInput, "same", jobKey, clock()),
    startComparisonJob(store, { ...jobInput, conditions: {} }, "same", jobKey, clock()),
  ]);
  assert.equal(same.filter((result) => result.tag === "ok" && result.value.created).length, 1);
  assert.equal(same.filter((result) => result.tag === "ok" && !result.value.created).length, 1);
  const mismatch = await Promise.all([
    startComparisonJob(store, jobInput, "different", jobKey, clock()),
    startComparisonJob(
      store,
      { ...jobInput, sort: "recommendation" },
      "different",
      jobKey,
      clock(),
    ),
  ]);
  assert.equal(mismatch.filter((result) => result.tag === "ok").length, 1);
  assert.equal(
    mismatch.filter(
      (result) => result.tag === "err" && result.error.code === "idempotency_conflict",
    ).length,
    1,
  );
  assert.deepEqual(
    await startComparisonJob(
      store,
      jobInput,
      "same",
      "different-capability-1234567890123456",
      clock(),
    ),
    { tag: "err", error: { code: "job_forbidden" } },
  );
});
await test("comparison runner deduplicates same-worker delivery, aborts cancelled work and rejects late result", async () => {
  const { clock } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const id = await acceptedJob(store, clock, "cancel-running");
  const began = barrier();
  const aborted = barrier();
  let calls = 0;
  const runner: ConsumerComparisonRunner = {
    compare: async (_input, options) => {
      calls += 1;
      began.release();
      options.signal.addEventListener("abort", aborted.release, { once: true });
      await aborted.wait;
      return ok({ status: "ranked", products: [] });
    },
  };
  const first = runComparisonJob(store, runner, id, "same-worker", clock, { watchIntervalMs: 2 });
  await began.wait;
  await runComparisonJob(store, runner, id, "same-worker", clock);
  await store.cancel(id, jobKey);
  await first;
  assert.equal(calls, 1);
  const finished = await store.read(id);
  assert.equal(finished.tag, "ok");
  assert.equal(finished.value?.state, "cancelled");
  assert.equal(finished.value.result, null);
  const queuedId = await acceptedJob(store, clock, "cancel-queued");
  await store.cancel(queuedId, jobKey);
  await runComparisonJob(store, runner, queuedId, "worker", clock);
  assert.equal(calls, 1);
});
await test("comparison runner takeover aborts old provider work, exceptions and deadlines become terminal failures", async () => {
  const { clock, advance } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const id = await acceptedJob(store, clock, "takeover");
  const began = barrier();
  const stopped = barrier();
  const waiting: ConsumerComparisonRunner = {
    compare: async (_input, options) => {
      began.release();
      options.signal.addEventListener("abort", stopped.release, { once: true });
      await stopped.wait;
      return err({ code: "aborted" });
    },
  };
  const old = runComparisonJob(store, waiting, id, "old-worker", clock, { watchIntervalMs: 2 });
  await began.wait;
  advance(46_000);
  const taken = await store.claim(id, "new-worker", "2026-10-06T12:01:30.000Z");
  assert.equal(taken.tag, "ok");
  await old;
  assert.equal((await store.read(id)).tag, "ok");
  const failureId = await acceptedJob(store, clock, "throws");
  await runComparisonJob(
    store,
    { compare: () => Promise.reject(new Error("private provider detail")) },
    failureId,
    "worker",
    clock,
  );
  const failed = await store.read(failureId);
  assert.equal(failed.tag, "ok");
  assert.equal(failed.value?.state, "failed");
  assert.equal(failed.value.error?.code, "comparison_failed");
  const deadlineId = await acceptedJob(store, clock, "deadline");
  const deadlineStopped = barrier();
  await runComparisonJob(
    store,
    {
      compare: async (_input, options) => {
        options.signal.addEventListener("abort", deadlineStopped.release, { once: true });
        await deadlineStopped.wait;
        return err({ code: "aborted" });
      },
    },
    deadlineId,
    "worker",
    clock,
    { deadlineMs: 10, watchIntervalMs: 2 },
  );
  const timeout = await store.read(deadlineId);
  assert.equal(timeout.tag, "ok");
  assert.equal(timeout.value?.state, "failed");
  assert.equal(timeout.value.error?.code, "job_deadline");
});
await test("comparison API returns before blocked runner, recovers lost responses and never discloses another capability", async () => {
  const { clock, advance } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const began = barrier();
  const hold = barrier();
  const completed = barrier();
  let runs = 0;
  const runner: ConsumerComparisonRunner = {
    compare: async (_input, options) => {
      runs += 1;
      began.release();
      await options.onProgress({ stage: "search", pages: 1, examined: 3 });
      await hold.wait;
      completed.release();
      return ok({
        source: { expiresAt: "2026-10-06T12:01:00.000Z" },
        status: "ranked",
        products: [],
        storageExpiresAt: null,
      });
    },
  };
  const token = "test-token-123456789012345678901234567890";
  const service = createConsumerComparisonService([], undefined, clock);
  const handler = createApiHandler(false, null, null, null, {
    consumerService: service,
    jobStore: store,
    clock,
    comparisonRunner: runner,
    apiAccessToken: token,
    allowedOrigin: "https://review.example",
  });
  const headers = { authorization: `Bearer ${token}`, "x-comparison-key": jobKey };
  const body = JSON.stringify({ ...jobInput, idempotencyKey: "lost-response" });
  const starting = handler({ path: "/api/comparisons", method: "POST", body, headers });
  const created = await fastResponse(starting, hold.release);
  assert.equal(created.statusCode, 202);
  await began.wait;
  const decoded: unknown = JSON.parse(created.body);
  assert.ok(record(decoded) && record(decoded["value"]));
  const snapshot = decoded["value"];
  assert.equal(snapshot["accessKey"], jobKey);
  assert.equal(snapshot["state"], "queued");
  const id = String(snapshot["id"]);
  const replay = await handler({ path: "/api/comparisons", method: "POST", body, headers });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.includes('"accessKey"'), false);
  assert.equal(runs, 1);
  const wrong = await handler({
    path: "/api/comparisons",
    method: "POST",
    body,
    headers: { ...headers, "x-comparison-key": "wrong-capability-12345678901234567890" },
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body.includes(id), false);
  const poll = await handler({ path: `/api/comparisons/${id}`, method: "GET", headers });
  assert.equal(poll.statusCode, 200);
  assert.equal(poll.body.includes('"stage":"search"'), true);
  const deniedRead = await handler({
    path: `/api/comparisons/${id}`,
    method: "GET",
    headers: { authorization: headers.authorization },
  });
  assert.equal(deniedRead.statusCode, 403);
  hold.release();
  await completed.wait;
  // Await the worker's transaction by repeatedly yielding until it reaches terminal state.
  let loaded = await store.read(id);
  for (
    let attempt = 0;
    attempt < 50 && loaded.tag === "ok" && loaded.value?.state === "running";
    attempt += 1
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    loaded = await store.read(id);
  }
  assert.equal(loaded.tag, "ok");
  assert.equal(loaded.value?.state, "succeeded");
  const cancellation = await handler({
    path: `/api/comparisons/${id}/cancel`,
    method: "POST",
    headers,
  });
  assert.equal(cancellation.statusCode, 200);
  assert.equal(cancellation.body.includes('"state":"succeeded"'), true);
  assert.equal(cancellation.body.includes('"result"'), true);
  advance(60_001);
  assert.equal(
    (await handler({ path: `/api/comparisons/${id}`, method: "GET", headers })).statusCode,
    410,
  );
  const scrubbed = await store.read(id);
  assert.equal(scrubbed.tag, "ok");
  assert.equal(scrubbed.value?.result, null);
  assert.equal(JSON.stringify(scrubbed).includes(jobKey), false);
  assert.equal(scrubbed.value.accessKeyDigest, await digestComparisonJobAccessKey(jobKey));
});

const event = {
  path: "/api/investigate",
  query: "",
  method: "POST",
  body: JSON.stringify({ url: "https://item.rakuten.co.jp/demo-shop/demo-product/" }),
} as const;

await test("Jev wiring excludes the 65W simultaneous mismatch, pins the model and keeps distributions", async (context) => {
  let failure = "none";
  let calls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    calls += 1;
    assert.equal(input, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options.redirect, "error");
    assert.ok(typeof options.body === "string");
    const body: unknown = JSON.parse(options.body);
    assert.ok(record(body) && record(body["state"]) && record(body["questions"]));
    assert.equal(body["model"], "jev-1.13.0");
    const facts = body["state"]["facts"];
    assert.ok(record(facts));
    assert.equal(Object.keys(body["questions"]).length, 1);
    assert.deepEqual(Object.keys(facts), [
      body["questions"]["port_operation"] === undefined ? "plugDescription" : "portLabeling",
    ]);
    assert.deepEqual(body["state"]["excerpts"], facts);
    const answers = Object.fromEntries(
      Object.entries(body["questions"]).map(([id, question]) => {
        assert.ok(record(question) && Array.isArray(question["criteria"]));
        const levels = question["criteria"];
        assert.equal(levels.length, 3);
        const score =
          id === "port_operation"
            ? facts["portLabeling"] === "Ports are labeled Laptop and Phone."
              ? 2
              : 1
            : facts["plugDescription"] === "The AC plug folds into the charger body."
              ? 2
              : 0;
        return [
          id,
          {
            type: "score",
            score,
            confidence: 1,
            legend: Object.fromEntries(
              levels.map((level: unknown, index: number) => [String(index), level]),
            ),
            probabilities: Object.fromEntries(
              levels.map((_level: unknown, index: number) => [
                String(index),
                failure === "distribution" ? 0 : index === score ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({ model: failure === "model" ? "jev-9.0.0" : "jev-1.13.0", answers }),
      ),
    );
  });
  const result = await rankDemoWithJev("example-key", "jev-1.13.0");
  assert.equal(result.tag, "ok");
  assert.deepEqual(result.value.excludedProductIds, ["demo-65w"]);
  assert.deepEqual(
    result.value.ranked.map((entry) => entry.productId),
    ["demo-85w", "demo-100w"],
  );
  assert.equal(result.value.ranked[0]?.internalIndex, 1);
  assert.equal(result.value.ranked[0].criteria[0]?.probabilities["2"], 1);
  assert.equal(calls, 4);
  for (const kind of ["model", "distribution"]) {
    failure = kind;
    assert.deepEqual(await rankDemoWithJev("example-key", "jev-1.13.0"), {
      tag: "err",
      error: { code: "invalid_jev_response" },
    });
  }
  const before = calls;
  assert.deepEqual(await rankDemoWithJev("example-key", "jev-latest"), {
    tag: "err",
    error: { code: "jev_unavailable" },
  });
  assert.equal(calls, before);
});

await test("HTTP boundary validates unknown input before comparison", async () => {
  const handler = createApiHandler(false);
  assert.equal((await handler(event)).statusCode, 200);
  for (const input of [
    null,
    {},
    { ...event, body: "{" },
    { ...event, body: "[]" },
    { ...event, body: new Uint8Array([123]) },
    { ...event, body: JSON.stringify({ url: "あ".repeat(1400) }) },
    { ...event, method: undefined },
    { ...event, body: JSON.stringify({ url: "x".repeat(2049) }) },
  ]) {
    assert.equal((await handler(input)).statusCode, 400);
  }
  assert.equal((await handler({ ...event, path: "/missing" })).statusCode, 404);
  assert.equal((await handler({ ...event, method: "DELETE" })).statusCode, 405);
  assert.equal(
    (await handler({ ...event, body: JSON.stringify({ url: "https://example.com/" }) })).statusCode,
    422,
  );
  assert.equal((await handler({ ...event, path: "/api/health", method: "GET" })).statusCode, 200);
  assert.equal(parseApiRequest({ ...event, method: "GET", query: "url=a&url=b" }).tag, "err");
});

await test("Firestore writes metadata once with a 30-day TTL and contains storage errors", async () => {
  const startedAt = Date.now();
  const retention = 30 * 24 * 60 * 60 * 1000;
  let writes = 0;
  const store = createFirestoreRunStore((input) => {
    writes += 1;
    assert.deepEqual(Object.keys(input), ["mode", "status", "createdAt", "expiresAt"]);
    assert.equal(input.mode, "demo");
    assert.equal(input.status, "succeeded");
    assert.ok(input.expiresAt.toMillis() >= startedAt + retention);
    assert.ok(input.expiresAt.toMillis() <= Date.now() + retention);
    assert.equal(JSON.stringify(input).includes("rakuten"), false);
    return Promise.resolve({});
  });
  assert.deepEqual(await store("succeeded"), { tag: "ok", value: null });
  assert.equal(writes, 1);
  const unavailable = createFirestoreRunStore(() =>
    Promise.reject(new Error("private credential")),
  );
  assert.deepEqual(await unavailable("failed"), {
    tag: "err",
    error: { code: "storage_unavailable" },
  });
});

const liveSettings = {
  applicationId: "example-app-1234",
  accessKey: "example-access-key-1234567890",
  affiliateId: "11111111.22222222.33333333.44444444",
  allowedOrigin: "https://example-compare.web.app/",
  authorizedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  accessToken: "example-test-token-12345678901234567890",
} as const;
const liveEvent = {
  ...event,
  headers: { authorization: `Bearer ${liveSettings.accessToken}` },
  body: JSON.stringify({
    url: "https://item.rakuten.co.jp/example-shop/url-slug/",
    keyword: "Example product",
  }),
};
const liveItem = {
  itemCode: "example-shop:10001234",
  itemName: "Example product",
  itemUrl: "https://item.rakuten.co.jp/example-shop/url-slug/?scid=tracking",
  affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${liveSettings.affiliateId}/?${new URLSearchParams({ pc: "https://item.rakuten.co.jp/example-shop/url-slug/", m: "https://item.rakuten.co.jp/example-shop/url-slug/" }).toString()}`,
  shopCode: "example-shop",
  shopName: "Example shop",
  itemPriceBaseField: "item_price_min3",
  itemPriceMin3: 1000,
  itemPriceMax3: 2000,
  taxFlag: 0,
  postageFlag: 0,
  availability: 1,
};

const openaiSettings = { apiKey: "sk-example-openai-key-1234567890", model: "gpt-6-luna" } as const;
await test("Rakuten legacy shop aliases and mobile item IDs rebuild to our own verified affiliate destination", async (context) => {
  let mismatchedMobile = false;
  context.mock.method(globalThis, "fetch", () => {
    const pc = "https://item.rakuten.co.jp/example-shop/url-slug/?rafcid=reference";
    const mobile = `http://m.rakuten.co.jp/${mismatchedMobile ? "wrong-shop" : "example-shop"}/i/10001234/?rafcid=reference`;
    const alias = `https://hb.afl.rakuten.co.jp/hgc/g00test0.12345678.g00test0.12345678/?${new URLSearchParams({ pc, m: mobile, rafcid: "reference" }).toString()}`;
    return Promise.resolve(
      new Response(
        JSON.stringify({ count: 1, Items: [{ ...liveItem, itemUrl: alias, affiliateUrl: alias }] }),
      ),
    );
  });
  const handler = createApiHandler(false, liveSettings);
  const response = await handler(liveEvent);
  assert.equal(response.statusCode, 200, response.body);
  const result: unknown = JSON.parse(response.body);
  assert.ok(
    record(result) &&
      record(result["value"]) &&
      typeof result["value"]["affiliateUrl"] === "string",
  );
  const link = new URL(result["value"]["affiliateUrl"]);
  assert.equal(link.pathname, `/hgc/${liveSettings.affiliateId}/`);
  assert.equal(link.searchParams.get("pc"), "https://item.rakuten.co.jp/example-shop/url-slug/");
  assert.equal(link.searchParams.get("m"), link.searchParams.get("pc"));
  assert.equal(link.searchParams.has("rafcid"), false);
  mismatchedMobile = true;
  assert.equal((await handler(liveEvent)).statusCode, 422);
});
const candidateEvent = {
  ...liveEvent,
  path: "/api/candidates",
  body: JSON.stringify({ requirements: "持ち運び用の65W USB-C充電器" }),
};
const planned = {
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ keyword: "65W USB-C 充電器" }) }],
    },
  ],
};

await test("API-first comparison excludes the source and duplicate models and skips paid AI when fields are complete", async (context) => {
  const models = ["MPA-ACCP4365BK", "MPA-ACCP4245WH", "MPA-AC113100BK"];
  const gtins = ["4549550281836", "4549550281829", "1234567890128"];
  const items = models.map((model, index) => {
    const canonical = `https://item.rakuten.co.jp/example-shop/product-${index}/`;
    return {
      ...liveItem,
      itemName: `USB-C充電器 ${model}`,
      itemCode: `example-shop:${1000 + index}`,
      itemUrl: canonical,
      affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${liveSettings.affiliateId}/?${new URLSearchParams({ pc: canonical, m: canonical }).toString()}`,
      itemPriceMin3: 1000 + index * 1000,
      itemPriceMax3: 1000 + index * 1000,
      itemCaption: `型番：${model}。最大出力：99W。USB-Cポート数：2。USB-Aポート数：0。重量：100g。保証期間：1年間。`,
      mediumImageUrls: [
        "https://thumbnail.image.rakuten.co.jp/@0_mall/example-shop/cabinet/product.jpg?_ex=128x128",
      ],
    };
  });
  let paidCalls = 0;
  let productRequests = 0;
  let priceChanged = false;
  let extractMissingWeight = false;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.openai.com/v1/responses") {
      paidCalls += 1;
      assert.equal(
        extractMissingWeight,
        true,
        "Complete API fields must not invoke paid extraction",
      );
      assert.ok(typeof options.body === "string");
      const request: unknown = JSON.parse(options.body);
      assert.ok(record(request) && typeof request["input"] === "string");
      assert.equal(request["store"], false);
      const batch: unknown = JSON.parse(request["input"]);
      assert.ok(Array.isArray(batch) && batch.length > 1 && batch.length <= 6);
      const products = batch.map((entry: unknown) => {
        assert.ok(record(entry) && typeof entry["description"] === "string");
        assert.deepEqual(entry["missingFields"], ["weightG"]);
        assert.ok(entry["description"].length <= 1800);
        assert.equal(entry["description"].includes("evidenceText"), false);
        return {
          listingId: entry["listingId"],
          facts: [{ field: "weightG", value: 106, quote: "重量は約106gです" }],
        };
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...planned,
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: JSON.stringify({ products }) }],
              },
            ],
          }),
        ),
      );
    }
    assert.ok(input instanceof URL);
    if (input.pathname.includes("Product/Search")) {
      productRequests += 1;
      const index = models.indexOf(input.searchParams.get("keyword") ?? "");
      assert.ok(index >= 0);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Products: [
              {
                productId: String(index + 1).repeat(32),
                productNo: models[index],
                productCode: gtins[index],
                productName: models[index],
                brandName: "エレコム",
                ProductDetails: [
                  { name: "最大出力", value: `${45 + index * 20}W` },
                  { name: "USB-Cポート数", value: "2" },
                  { name: "USB-Aポート数", value: "0" },
                  { name: "重量", value: "100g" },
                  { name: "保証期間", value: "1年間" },
                ].filter((detail) => !extractMissingWeight || detail.name !== "重量"),
              },
            ],
          }),
        ),
      );
    }
    const sourceCopy = "https://item.rakuten.co.jp/example-shop/source-copy/";
    const entries =
      input.searchParams.get("shopCode") === null
        ? [
            items[1],
            items[1],
            items[2],
            {
              ...items[0],
              itemCode: "example-shop:9999",
              itemUrl: sourceCopy,
              affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${liveSettings.affiliateId}/?${new URLSearchParams({ pc: sourceCopy, m: sourceCopy }).toString()}`,
            },
          ]
        : [items[0]];
    const priced = entries.map((entry) => ({
      ...entry,
      ...(priceChanged && entry?.itemCode === "example-shop:1001"
        ? { itemPriceMin3: 5000, itemPriceMax3: 5000 }
        : {}),
      ...(extractMissingWeight && entry?.itemCaption !== undefined
        ? { itemCaption: entry.itemCaption.replace("重量：100g", "重量は約106gです") }
        : {}),
    }));
    return Promise.resolve(new Response(JSON.stringify({ count: priced.length, Items: priced })));
  });
  const handler = createApiHandler(false, liveSettings, openaiSettings);
  const response = await handler({
    ...candidateEvent,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/example-shop/product-0/",
      keyword: models[0],
      requirements: "持ち運び用",
      comparisonMode: "price",
    }),
  });
  assert.equal(response.statusCode, 200, response.body);
  const body: unknown = JSON.parse(response.body);
  assert.ok(record(body) && record(body["value"]));
  const result = body["value"];
  assert.equal(result["status"], "ranked");
  assert.ok(Array.isArray(result["products"]));
  assert.equal(result["products"].length, 2);
  assert.ok(record(result["products"][0]) && record(result["products"][0]["specifications"]));
  assert.equal(result["products"][0]["specifications"]["maxPowerW"], 65);
  assert.equal(result["products"][0]["recommendationPercent"], 100);
  assert.equal(paidCalls, 0);
  assert.equal(response.body.includes("itemCaption"), false);
  assert.equal(response.body.includes(liveSettings.accessKey), false);
  const before = productRequests;
  priceChanged = true;
  const refreshed = await handler({
    ...candidateEvent,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/example-shop/product-0/",
      keyword: models[0],
      requirements: "持ち運び用",
      comparisonMode: "price",
    }),
  });
  const updated: unknown = JSON.parse(refreshed.body);
  assert.ok(
    record(updated) && record(updated["value"]) && Array.isArray(updated["value"]["products"]),
  );
  assert.ok(record(updated["value"]["products"][0]));
  assert.equal(updated["value"]["products"][0]["listingId"], "example-shop:1002");
  assert.equal(
    productRequests,
    before,
    "unchanged specifications must be reused while new prices stay fresh",
  );
  extractMissingWeight = true;
  const extractionEvent = {
    ...candidateEvent,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/example-shop/product-0/",
      keyword: models[0],
      requirements: "持ち運び用",
      comparisonMode: "ai",
    }),
  };
  const extracted = await handler(extractionEvent);
  const extractionBody: unknown = JSON.parse(extracted.body);
  assert.equal(extracted.statusCode, 200, extracted.body);
  assert.ok(
    record(extractionBody) &&
      record(extractionBody["value"]) &&
      Array.isArray(extractionBody["value"]["products"]),
  );
  for (const product of extractionBody["value"]["products"]) {
    assert.ok(
      record(product) &&
        record(product["specifications"]) &&
        Array.isArray(product["specificationFacts"]),
    );
    assert.equal(product["specifications"]["weightG"], 106);
    assert.ok(
      product["specificationFacts"].some(
        (fact: unknown) =>
          record(fact) && fact["field"] === "weightG" && fact["source"] === "ai-description",
      ),
    );
  }
  assert.equal(paidCalls, 1, "all missing descriptions must be extracted in one batch");
  assert.equal((await handler(extractionEvent)).statusCode, 200);
  assert.equal(paidCalls, 1, "repeated descriptions must reuse extracted specifications");
});

await test("main AI plans search from user input, then verified listings supply all product facts and monetized links", async (context) => {
  const calls: string[] = [];
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.openai.com/v1/responses") {
      calls.push("openai");
      assert.equal(
        new Headers(options.headers).get("Authorization"),
        `Bearer ${openaiSettings.apiKey}`,
      );
      assert.equal(options.redirect, "error");
      assert.equal(typeof options.body, "string");
      assert.ok(typeof options.body === "string");
      const body: unknown = JSON.parse(options.body);
      assert.ok(
        typeof body === "object" &&
          body !== null &&
          "store" in body &&
          "input" in body &&
          "model" in body,
      );
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.input, "持ち運び用の65W USB-C充電器");
      assert.equal(options.body.includes(liveItem.itemName), false);
      assert.equal(options.body.includes(liveSettings.accessKey), false);
      assert.equal(options.body.includes(liveSettings.affiliateId), false);
      return Promise.resolve(new Response(JSON.stringify(planned)));
    }
    assert.ok(input instanceof URL);
    calls.push("rakuten");
    assert.equal(input.origin, "https://openapi.rakuten.co.jp");
    assert.equal(input.searchParams.get("keyword"), "65W USB-C 充電器");
    assert.equal(input.searchParams.get("shopCode"), null);
    assert.equal(input.searchParams.get("hits"), "10");
    assert.equal(input.searchParams.get("affiliateId"), liveSettings.affiliateId);
    return Promise.resolve(
      new Response(
        JSON.stringify({ count: 3, Items: [liveItem, liveItem, { ...liveItem, availability: 0 }] }),
      ),
    );
  });
  const response = await createApiHandler(false, liveSettings, openaiSettings)(candidateEvent);
  assert.equal(response.statusCode, 200);
  const body: unknown = JSON.parse(response.body);
  assert.ok(typeof body === "object" && body !== null && "value" in body);
  assert.ok(
    typeof body.value === "object" &&
      body.value !== null &&
      "listings" in body.value &&
      "keyword" in body.value,
  );
  assert.equal(body.value.keyword, "65W USB-C 充電器");
  const listings: unknown = body.value.listings;
  assert.ok(Array.isArray(listings));
  assert.equal(listings.length, 1);
  const listing: unknown = listings[0];
  assert.ok(
    typeof listing === "object" &&
      listing !== null &&
      "affiliateUrl" in listing &&
      "productId" in listing,
  );
  assert.equal(listing.affiliateUrl, liveItem.affiliateUrl);
  assert.equal(listing.productId, null);
  assert.deepEqual(calls, ["openai", "rakuten"]);
  assert.equal(response.body.includes(openaiSettings.apiKey), false);
  assert.equal(response.headers["cache-control"], "no-store");
});

await test("candidate authentication, missing key, expiry and invalid input stop paid calls", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const handler = createApiHandler(false, liveSettings, openaiSettings);
  assert.equal((await handler({ ...candidateEvent, headers: {} })).statusCode, 401);
  assert.equal((await handler({ ...candidateEvent, method: "GET" })).statusCode, 405);
  for (const requirements of [undefined, " ", "x".repeat(1001), 1]) {
    assert.equal(
      (await handler({ ...candidateEvent, body: JSON.stringify({ requirements }) })).statusCode,
      400,
    );
  }
  const unconfigured = await createApiHandler(false, liveSettings)(candidateEvent);
  assert.equal(unconfigured.statusCode, 503);
  assert.match(unconfigured.body, /main_ai_not_configured/);
  assert.equal(
    (
      await createApiHandler(
        false,
        { ...liveSettings, authorizedUntil: "2026-01-01T00:00:00.000Z" },
        openaiSettings,
      )(candidateEvent)
    ).statusCode,
    422,
  );
  assert.throws(() =>
    createApiHandler(false, liveSettings, { ...openaiSettings, model: "bad/model" }),
  );
});

await test("incomplete, refused, invented and failed AI outputs never become product candidates", async (context) => {
  let upstream = new Response("", { status: 429 });
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    assert.equal(input, "https://api.openai.com/v1/responses");
    return Promise.resolve(upstream);
  });
  const handler = createApiHandler(false, liveSettings, openaiSettings);
  for (const [status, expected] of [
    [429, 429],
    [401, 503],
    [500, 503],
  ] as const) {
    upstream = new Response("private provider diagnostic", { status });
    const response = await handler(candidateEvent);
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.includes("private provider diagnostic"), false);
  }
  for (const body of [
    { ...planned, status: "incomplete" },
    { ...planned, output: [] },
    {
      ...planned,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "no" }],
        },
      ],
    },
    ...[
      { keyword: "" },
      { keyword: "あ".repeat(43) },
      { keyword: "65W", products: ["invented"] },
      { keyword: "bad\nquery" },
    ].map((plan) => ({
      ...planned,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(plan) }],
        },
      ],
    })),
  ]) {
    upstream = new Response(JSON.stringify(body));
    const response = await handler(candidateEvent);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /invalid_ai_response/);
  }
});

await test("live lookup uses an exact URL, preserves SKU ranges and never invents product identity", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    calls++;
    assert.ok(input instanceof URL);
    assert.equal(input.origin, "https://openapi.rakuten.co.jp");
    assert.equal(input.pathname, "/ichibams/api/IchibaItem/Search/20260701");
    assert.equal(input.searchParams.get("itemCode"), null);
    assert.equal(input.searchParams.get("affiliateId"), liveSettings.affiliateId);
    assert.equal(input.searchParams.get("elements")?.split(",").includes("affiliateUrl"), true);
    assert.equal(input.searchParams.get("keyword"), "Example product");
    assert.equal(input.searchParams.get("shopCode"), "example-shop");
    assert.equal(input.searchParams.get("formatVersion"), "2");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("accessKey"), liveSettings.accessKey);
    assert.equal(headers.get("Origin"), "https://example-compare.web.app");
    assert.equal(options.redirect, "error");
    return Promise.resolve(
      new Response(
        JSON.stringify({ count: 1, Items: [{ ...liveItem, itemUrl: liveItem.affiliateUrl }] }),
      ),
    );
  });
  const handler = createApiHandler(false, liveSettings);
  const response = await handler(liveEvent);
  assert.equal(response.statusCode, 200);
  const result: unknown = JSON.parse(response.body);
  assert.ok(typeof result === "object" && result !== null && "value" in result);
  const value = result.value;
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "productId" in value &&
      "listingId" in value &&
      "price" in value &&
      "affiliateUrl" in value &&
      "matchMethod" in value,
  );
  assert.equal(value.productId, null);
  assert.equal(value.matchMethod, null);
  assert.equal(value.listingId, "example-shop:10001234");
  assert.deepEqual(value.price, { minimum: 1000, maximum: 2000, currency: "JPY" });
  assert.equal(value.affiliateUrl, liveItem.affiliateUrl);
  assert.equal(calls, 1);
  assert.equal(response.body.includes(liveSettings.accessKey), false);
  assert.equal(response.body.includes(liveSettings.accessToken), false);
  assert.equal(response.headers["cache-control"], "no-store");
});

await test("live authorization, expiry and URL validation prevent external calls", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const handler = createApiHandler(false, liveSettings);
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { authorization: `Bearer ${liveSettings.accessToken},other` },
  ]) {
    assert.equal((await handler({ ...liveEvent, headers })).statusCode, 401);
  }
  assert.equal(
    (await handler({ ...liveEvent, headers: { authorization: "x", Authorization: "y" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await handler({
        ...liveEvent,
        method: "GET",
        query: "url=https://item.rakuten.co.jp/example-shop/url-slug/",
      })
    ).statusCode,
    405,
  );
  for (const url of [
    "https://127.0.0.1/",
    "https://evil.example/shop/item/",
    "https://item.rakuten.co.jp/example-shop/url-slug/?sku=other",
  ]) {
    assert.equal((await handler({ ...liveEvent, body: JSON.stringify({ url }) })).statusCode, 422);
  }
  assert.equal(
    (
      await handler({
        ...liveEvent,
        body: JSON.stringify({
          url: "https://item.rakuten.co.jp/example-shop/url-slug/",
          keyword: "あ".repeat(43),
        }),
      })
    ).statusCode,
    400,
  );
  const expired = createApiHandler(false, {
    ...liveSettings,
    authorizedUntil: "2026-01-01T00:00:00.000Z",
  });
  const denied = await expired(liveEvent);
  assert.equal(denied.statusCode, 422);
  assert.match(denied.body, /source_not_authorized/);
  assert.throws(() => createApiHandler(false, {}));
  assert.throws(() => createApiHandler(false, { ...liveSettings, accessToken: "short" }));
  assert.throws(() => createApiHandler(false, { ...liveSettings, affiliateId: undefined }));
  assert.throws(() => createApiHandler(false, { ...liveSettings, affiliateId: "bad/id" }));
});

await test("live lookup rejects wrong listings, invalid prices and upstream failures", async (context) => {
  let upstream = new Response("", { status: 429 });
  context.mock.method(globalThis, "fetch", () => Promise.resolve(upstream));
  const handler = createApiHandler(false, liveSettings);
  for (const [status, expected, code] of [
    [429, 429, "provider_rate_limited"],
    [403, 503, "provider_unauthorized"],
    [500, 503, "provider_unavailable"],
    [404, 422, "listing_not_found"],
  ] as const) {
    upstream = new Response("private diagnostic", { status });
    const response = await handler(liveEvent);
    assert.equal(response.statusCode, expected);
    assert.match(response.body, new RegExp(code));
    assert.equal(response.body.includes("private diagnostic"), false);
  }
  for (const item of [
    { ...liveItem, itemUrl: "https://item.rakuten.co.jp/example-shop/another-item/" },
    { ...liveItem, itemUrl: "https://evil.example/item/" },
    { ...liveItem, itemPriceMin3: -1 },
    { ...liveItem, itemPriceMax3: 999 },
    { ...liveItem, taxFlag: 9 },
    { ...liveItem, itemCode: "wrong-shop:1234" },
    { ...liveItem, affiliateUrl: undefined },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace(
        liveSettings.affiliateId,
        "aaaaaaaa.bbbbbbbb.cccccccc.dddddddd",
      ),
    },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace("hb.afl.rakuten.co.jp", "evil.example"),
    },
    { ...liveItem, affiliateUrl: `${liveItem.affiliateUrl}&pc=https%3A%2F%2Fevil.example%2F` },
    {
      ...liveItem,
      affiliateUrl: liveItem.affiliateUrl.replace(
        "m=https%3A%2F%2Fitem.rakuten.co.jp%2Fexample-shop%2Furl-slug%2F",
        "m=https%3A%2F%2Fevil.example%2F",
      ),
    },
  ]) {
    upstream = new Response(JSON.stringify({ count: 1, Items: [item] }));
    assert.equal((await handler(liveEvent)).statusCode, 422);
  }
  upstream = new Response(JSON.stringify({ count: 31, Items: [] }));
  assert.match((await handler(liveEvent)).body, /lookup_incomplete/);
  upstream = new Response(JSON.stringify({ count: 2, Items: [liveItem, liveItem] }));
  assert.match((await handler(liveEvent)).body, /ambiguous_listing/);
  upstream = new Response("{");
  assert.equal((await handler(liveEvent)).statusCode, 503);
});
const confirmedUse = {
  devices: [
    {
      id: "laptop",
      protocol: "pd",
      voltageV: 20,
      currentA: 3.25,
      cable: { maxCurrentA: 5, maxVoltageV: 20 },
    },
    {
      id: "phone",
      protocol: "pd",
      voltageV: 5,
      currentA: 3,
      cable: { maxCurrentA: 3, maxVoltageV: 20 },
    },
  ],
  portPreference: "prefer_roles",
  plugPreference: "prefer_folding",
} as const;

await test("confirmed demo comparison retains the source, gates charging, reverses preferences and makes no AI calls", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const handler = createApiHandler(false);
  const input = {
    url: "https://item.rakuten.co.jp/demo-shop/demo-product/",
    operation: "compare",
    conditions: confirmedUse,
    confirmed: true,
  };
  const compare = async (conditions: unknown) => {
    const response = await handler({ ...event, body: JSON.stringify({ ...input, conditions }) });
    assert.equal(response.statusCode, 200);
    const decoded: unknown = JSON.parse(response.body);
    assert.ok(record(decoded) && record(decoded["value"]));
    return decoded["value"];
  };
  const baseline = await compare(confirmedUse);
  assert.equal(baseline["status"], "ranked");
  assert.ok(record(baseline["source"]));
  assert.equal(baseline["source"]["productId"], "demo-65w");
  const products = baseline["products"];
  assert.ok(Array.isArray(products));
  assert.deepEqual(
    products.map((entry: unknown) =>
      record(entry) ? [entry["productId"], entry["rank"], entry["status"]] : null,
    ),
    [
      ["demo-85w", 1, "eligible"],
      ["demo-100w", 2, "eligible"],
      ["demo-65w", null, "excluded"],
    ],
  );
  assert.equal(
    products.filter((entry: unknown) => record(entry) && entry["isSource"] === true).length,
    1,
  );
  const fixed = await compare({
    ...confirmedUse,
    portPreference: "ignore",
    plugPreference: "prefer_fixed",
  });
  assert.ok(Array.isArray(fixed["products"]));
  assert.equal(
    record(fixed["products"][0]) ? fixed["products"][0]["productId"] : null,
    "demo-100w",
  );
  const off = await compare({
    ...confirmedUse,
    portPreference: "ignore",
    plugPreference: "ignore",
  });
  assert.equal(off["status"], "unranked");
  assert.ok(Array.isArray(off["products"]));
  assert.equal(
    off["products"].every((entry: unknown) => record(entry) && entry["rank"] === null),
    true,
  );
  const unknown = await compare({
    ...confirmedUse,
    devices: confirmedUse.devices.map((device) => ({ ...device, cable: null })),
  });
  assert.equal(unknown["status"], "needs_information");
  for (const patch of [
    { confirmed: false },
    { confirmed: "true" },
    { conditions: { ...confirmedUse, plugPreference: "invented" } },
    { conditions: null },
    { conditions: { ...confirmedUse, devices: [] } },
  ]) {
    assert.equal(
      (await handler({ ...event, body: JSON.stringify({ ...input, ...patch }) })).statusCode,
      400,
    );
  }
  assert.equal(
    (
      await createApiHandler(
        false,
        liveSettings,
        openaiSettings,
      )({ ...liveEvent, body: JSON.stringify(input) })
    ).statusCode,
    422,
  );
});

await test("structured live comparison verifies the source before planning, excludes its listing and holds unverified specifications", async (context) => {
  const calls: string[] = [];
  const rivalUrl = "https://item.rakuten.co.jp/example-shop/rival/";
  const rival = {
    ...liveItem,
    itemCode: "example-shop:rival",
    itemUrl: rivalUrl,
    affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${liveSettings.affiliateId}/?${new URLSearchParams({ pc: rivalUrl, m: rivalUrl }).toString()}`,
  };
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.openai.com/v1/responses") {
      calls.push("openai");
      assert.ok(typeof options.body === "string");
      assert.equal(options.body.includes(liveItem.itemName), false);
      assert.equal(options.body.includes(liveItem.itemUrl), false);
      assert.equal(options.body.includes(liveSettings.accessKey), false);
      assert.equal(options.body.includes("prefer_fixed"), true);
      return Promise.resolve(new Response(JSON.stringify(planned)));
    }
    assert.ok(input instanceof URL);
    if (input.searchParams.get("shopCode") !== null) {
      calls.push("lookup");
      return Promise.resolve(new Response(JSON.stringify({ count: 1, Items: [liveItem] })));
    }
    calls.push("search");
    return Promise.resolve(
      new Response(JSON.stringify({ count: 3, Items: [liveItem, rival, rival] })),
    );
  });
  const input = {
    url: "https://item.rakuten.co.jp/example-shop/url-slug/",
    keyword: "Example product",
    conditions: { ...confirmedUse, plugPreference: "prefer_fixed" },
    confirmed: true,
    requirements: "持ち歩き",
  };
  const handler = createApiHandler(false, liveSettings, openaiSettings);
  const response = await handler({ ...candidateEvent, body: JSON.stringify(input) });
  assert.equal(response.statusCode, 200);
  const decoded: unknown = JSON.parse(response.body);
  assert.ok(record(decoded) && record(decoded["value"]));
  const value = decoded["value"];
  assert.equal(value["mode"], "live");
  assert.equal(value["status"], "needs_information");
  assert.ok(record(value["source"]));
  assert.equal(value["source"]["listingId"], liveItem.itemCode);
  assert.equal(value["source"]["productId"], null);
  assert.ok(Array.isArray(value["listings"]));
  assert.equal(value["listings"].length, 1);
  assert.equal(response.body.includes('"rank"'), false);
  assert.deepEqual(calls, ["lookup", "openai", "search"]);
  const before = calls.length;
  for (const patch of [
    { confirmed: false },
    { url: undefined },
    { keyword: 1 },
    { requirements: "x".repeat(201) },
    { keyword: "あ".repeat(43) },
    {
      conditions: {
        ...confirmedUse,
        devices: [{ ...confirmedUse.devices[0], currentA: Number.NaN }],
      },
    },
  ]) {
    assert.equal(
      (await handler({ ...candidateEvent, body: JSON.stringify({ ...input, ...patch }) }))
        .statusCode,
      400,
    );
  }
  assert.equal(
    (
      await handler({
        ...candidateEvent,
        body: JSON.stringify({ ...input, url: "https://evil.example/" }),
      })
    ).statusCode,
    422,
  );
  assert.equal(calls.length, before);
});
await test("official comparison verifies manufacturer identity and active-port profiles; changes stop judgment", async (context) => {
  const pages: Readonly<Record<string, string>> = {
    "https://www.elecom.co.jp/products/MPA-AC12465BK.html":
      '<script type="application/ld+json">{"@type":"Product","mpn":"MPA-AC12465BK","brand":{"name":"ELECOM"}}</script>JANコード: 4549550414449<table>' +
      (
        [
          ["カラー", "ブラック"],
          ["コネクター形状", "USBType-Cポート×1"],
          ["コンセントプラグ仕様", "90度スイング構造"],
          ["外形寸法", "幅約42.5mm×奥行約41.5mm×高さ約41.5mm"],
          ["定格入力電圧", "AC100～240V、50/60Hz"],
          ["定格入力電流", "1.6A"],
          ["定格出力電力", "最大出力65W、PPS最大出力65W"],
          ["定格出力電圧", "5V/9V/12V/15V/20V、PPS出力5V～11V/5V～21V"],
          [
            "定格出力電流",
            "5V時3A/9V時3A/12V時3A/15V時3A/20V時3.25A、PPS出力5V～11V時4.05A、5V～21V時3.05A",
          ],
          ["重量", "約100g"],
        ] as const
      )
        .map(([key, value]) => `<tr><th>${key}</th><td>${value}</td></tr>`)
        .join("") +
      "</table>",
    "https://www.elecom.co.jp/products/MPA-ACCP4245WH.html":
      '<script type="application/ld+json">{"@type":"Product","mpn":"MPA-ACCP4245WH","brand":{"name":"ELECOM"}}</script>JANコード: 4549550281829<table><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コネクター形状</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C(TM)(USB-C(TM))ポート×2</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電圧</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>AC100～240V、50/60Hz</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電流</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>1.2A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>外形寸法</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>幅約44mm×厚み約38mm×高さ約40.5mm</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>重量</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>約88g</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>カラー</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>ホワイト</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コンセントプラグ仕様</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>90度スイング構造</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))/USB Type-C2ポート最大出力45W、PPS最大出力45W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：合計最大出力45W、USB Type-C1ポート最大出力25W、PPS最大出力25W、USB Type-C2ポート最大出力20W、PPS最大出力20W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))ポート/USB Type-C2ポート：5V/9V/12V/15V/20V､PPS出力3.3～16V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：USB Type-C1ポート：5V/9V、PPS出力3.3～5.9V/3.3～11V、USB Type-C2ポート：5V/9V、PPS出力3.3～5.9V/3.3～11V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))ポート/USB Type-C2ポート：5V/9V/12V/15V時3A、20V時2.25A､PPS出力3.3～16V時3A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：USB Type-C1ポート：5V時3A、9V時2.77A、PPS出力3.3～5.9V時3A、3.3～11V時2.75A、USB Type-C2ポート：5V時3A、9V時2.22A、PPS出力3.3～5.9V時3A、3.3～11V時2A</td></table>',
    "https://www.elecom.co.jp/products/MPA-ACCP4365BK.html":
      '<script type="application/ld+json">{"@type":"Product","mpn":"MPA-ACCP4365BK","brand":{"name":"ELECOM"}}</script>JANコード: 4549550281836<table><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コネクター形状</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C(TM)(USB-C(TM))ポート×2</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電圧</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>AC100～240V、50/60Hz</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電流</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>1.5A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>外形寸法</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>幅約52mm×厚み約38mm×高さ約40.5mm</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>重量</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>約106g</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>カラー</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>ブラック</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コンセントプラグ仕様</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>90度スイング構造</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))/USB Type-C2ポート最大出力65W、PPS最大出力65W、QC最大出力18W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：合計最大出力65W、USB Type-C1ポート最大出力45W、PPS最大出力45W、QC最大出力18W、USB Type-C2ポート最大出力20W、PPS最大出力20W、QC最大出力18W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))ポート/USB Type-C2ポート：5V/9V/12V/15V/20V､PPS出力3.3～21V、QC出力3.6～6V/6～9V/9～12V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：USB Type-C1ポート：5V/9V/12V/15V/20V、PPS出力3.3～16V、QC出力3.6～6V/6～9V/9～12V、USB Type-C2ポート：5V/9V、PPS出力3.3～5.9V/3.3～11V、QC出力3.6～6V/6～9V/9～12V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流1</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>単独接続時：USB Type-C1(TM)(USB-C1(TM))ポート/USB Type-C2ポート：5V/9V/12V/15V時3A、20V時3.25A､PPS出力3.3～21V時3.25A、QC出力3.6～6V時3A、6～9V時2A、9～12V時1.5A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流2</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2ポート同時接続時：USB Type-C1ポート：5V/9V/12V/15V時3A、20V時2.25A、PPS出力3.3～16V時3A、QC出力3.6～6V時3A、6～9V時2A、9～12V時1.5A、USB Type-C2ポート：5V時3A、9V時2.22A、PPS出力3.3～5.9V時3A、3.3～11V時2A、QC出力3.6～6V時3A、6～9V時2A、9～12V時1.5A</td></table>',
    "https://www.elecom.co.jp/products/MPA-AC113100BK.html":
      '<script type="application/ld+json">{"@type":"Product","mpn":"MPA-AC113100BK","brand":{"name":"ELECOM"}}</script>JANコード: 4549550367592<table><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コネクター形状</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-Cポート×3</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電圧</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>AC100～240V、50/60Hz</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格入力電流</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>2A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力(単独接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1/C2/C3ポート：最大出力100W、PPS最大出力100W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力(2ポート同時接続時(1))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1+USB Type-C2/C3ポート：合計最大出力100W、USB Type-C1ポート最大出力70W、PPS最大出力55W、USB Type-C2/C3ポート最大出力30W、PPS最大出力30W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力(2ポート同時接続時(2))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C2+USB Type-C3ポート：合計最大出力24W、USB Type-C2/C3ポート最大出力12W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電力(3ポート同時接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>合計最大出力94W、USB Type-C1ポート最大出力70W、PPS最大出力55W、USB Type-C2/C3ポート最大出力12W</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧(単独接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1/C2/C3ポート：5V/9V/15V/20V、PPS出力5～21V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧(2ポート同時接続時(1))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>［USB Type-C1+USB Type-C2/C3ポート接続時］USB Type-C1ポート：5V/9V/15V/20V、PPS出力5～11V、USB Type-C2/C3ポート：5V/9V/15V/20V、PPS出力5～11V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧(2ポート同時接続時(2))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>［USB Type-C2+USB Type-C3ポート接続時］USB Type-C2/C3ポート：5V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電圧(3ポート同時接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1ポート：5V/9V/15V/20V、PPS出力5～11V、USB Type-C2/C3ポート：5V</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流(単独接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1/C2/C3ポート：5V/9V/15V時3A・20V時5A、PPS出力5～21V時5A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流(2ポート同時接続時(1))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>［USB Type-C1+USB Type-C2/C3ポート接続時］USB Type-C1ポート：5V/9V/15V時3A・20V時3.5A、PPS出力5～11V時5A、USB Type-C2/C3ポート：5V/9V時3A・15V時2A・20V時1.5A、PPS出力5～11V時3A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流(2ポート同時接続時(2))</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>［USB Type-C2+USB Type-C3ポート接続時］USB Type-C2/C3ポート：5V時2.4A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>定格出力電流(3ポート同時接続時)</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>USB Type-C1ポート：5V/9V/15V時3A・20V時3.5A、PPS出力5～11V時5A、USB Type-C2/C3ポート：5V時2.4A</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>外形寸法</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>幅約55.5mm×奥行約40.6mm×高さ約46.6mm</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>重量</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>約185g</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>カラー</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>ブラック</td><tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>コンセントプラグ仕様</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<td>90度スイング構造</td></table>',
  };
  let mutation = (html: string): string => html;
  let requests = 0;
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    requests += 1;
    assert.ok(typeof input === "string" && pages[input] !== undefined);
    return Promise.resolve(
      new Response(mutation(pages[input]), { headers: { "content-type": "text/html" } }),
    );
  });
  const handler = createApiHandler(false);
  const url = "https://www.elecom.co.jp/products/MPA-ACCP4365BK.html";
  const devices = [
    {
      id: "phone",
      protocol: "pd",
      voltageV: 5,
      currentA: 3,
      cable: { maxCurrentA: 3, maxVoltageV: 20 },
    },
    {
      id: "laptop",
      protocol: "pd",
      voltageV: 20,
      currentA: 3.25,
      cable: { maxCurrentA: 5, maxVoltageV: 20 },
    },
  ];
  const conditions = { devices, portPreference: "ignore", plugPreference: "require_folding" };
  const send = (input: unknown) => handler({ ...event, body: JSON.stringify(input) });
  const lookup = await send({ url });
  assert.equal(lookup.statusCode, 200);
  const found: unknown = JSON.parse(lookup.body);
  assert.ok(record(found) && record(found["value"]));
  assert.equal(found["value"]["mode"], "official");
  assert.equal(found["value"]["gtin"], "4549550281836");
  assert.equal(found["value"]["color"], "ブラック");
  const comparison = await send({ url, operation: "compare", confirmed: true, conditions });
  assert.equal(comparison.statusCode, 200);
  const response: unknown = JSON.parse(comparison.body);
  assert.ok(
    record(response) && record(response["value"]) && Array.isArray(response["value"]["products"]),
  );
  const products: readonly unknown[] = response["value"]["products"];
  const winner = products.find((entry) => record(entry) && entry["productId"] === "MPA-AC113100BK");
  assert.ok(record(winner));
  assert.equal(winner["status"], "eligible");
  assert.deepEqual(winner["assignments"], [
    { deviceId: "phone", port: "C2" },
    { deviceId: "laptop", port: "C1" },
  ]);
  assert.equal(
    products.filter((entry) => record(entry) && entry["status"] === "excluded").length,
    3,
  );
  for (const [voltageV, currentA, status] of [
    [11, 4.05, "eligible"],
    [11.02, 4.05, "excluded"],
    [20, 3.25, "excluded"],
  ] as const) {
    const checked = await send({
      url: "https://www.elecom.co.jp/products/MPA-AC12465BK.html",
      operation: "compare",
      confirmed: true,
      conditions: {
        ...conditions,
        devices: [
          {
            id: "phone",
            protocol: "pps",
            voltageV,
            currentA,
            cable: { maxCurrentA: 5, maxVoltageV: 20 },
          },
        ],
      },
    });
    assert.equal(checked.statusCode, 200);
    const body: unknown = JSON.parse(checked.body);
    assert.ok(record(body) && record(body["value"]) && Array.isArray(body["value"]["products"]));
    const entries: readonly unknown[] = body["value"]["products"];
    const target = entries.find((entry) => record(entry) && entry["productId"] === "MPA-AC12465BK");
    assert.ok(record(target));
    assert.equal(target["isSource"], true);
    assert.equal(target["status"], status);
  }
  for (const change of [
    (html: string): string => html.replaceAll("4549550281836", "4549550281829"),
    (html: string): string => html.replaceAll("4.05A", "4.5A"),
    (html: string): string => html.replaceAll("3.25A", "3.5A"),
    (html: string): string => html.replaceAll("約106g", "約99g"),
    (html: string): string => html.replaceAll("MPA-ACCP4365BK", "OTHER"),
  ]) {
    mutation = change;
    const result = await send({ url, operation: "compare", confirmed: true, conditions });
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), {
      tag: "err",
      error: { code: "official_specification_changed" },
    });
  }
  const before = requests;
  for (const suffix of [
    "UNKNOWN.html",
    "MPA-ACCP4365BK.html?variant=white",
    "MPA-ACCP4365BK.html#spec",
  ]) {
    assert.equal(
      (await send({ url: `https://www.elecom.co.jp/products/${suffix}` })).statusCode,
      422,
    );
    assert.equal(
      (
        await send({
          url: `https://www.elecom.co.jp/products/${suffix}`,
          operation: "compare",
          confirmed: true,
          conditions,
        })
      ).statusCode,
      422,
    );
  }
  assert.equal(requests, before);
});

const monitorConditions = {
  screenSize: null,
  minResolution: null,
  usbCPowerW: 0,
  heightAdjustable: false,
};

const monitorSettings = {
  applicationId: "example-app-1234",
  accessKey: "example-access-key-1234567890",
  affiliateId: "11111111.22222222.33333333.44444444",
  allowedOrigin: "https://example-compare.web.app/",
  authorizedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  accessToken: "example-test-token-12345678901234567890",
};

function consumerGtin(index: number): string {
  const prefix = `49012345${String(index).padStart(4, "0")}`;
  const sum = (prefix.match(/\d/g) ?? []).reduce(
    (total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 1 : 3),
    0,
  );
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

function consumerItem(
  index: number,
  genreId: string,
  caption: string,
  price = 80000,
  slug = `consumer-${index}`,
) {
  const canonicalUrl = `https://item.rakuten.co.jp/shop/${slug}/`;
  return {
    itemCode: `shop:${slug}`,
    itemName: `【新品】商品 CONSUMER-${index}`,
    itemUrl: canonicalUrl,
    affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${monitorSettings.affiliateId}/?${new URLSearchParams({ pc: canonicalUrl, m: canonicalUrl }).toString()}`,
    itemCaption: `新品\n型番: CONSUMER-${index}\n${caption}`,
    shopCode: "shop",
    shopName: "Example shop",
    itemPriceBaseField: "item_price_min1",
    itemPriceMin1: price,
    itemPriceMax1: price,
    taxFlag: 0,
    postageFlag: 1,
    availability: 1,
    genreId,
  };
}

function consumerProductResponse(input: URL): Response {
  const model = input.searchParams.get("keyword") ?? "";
  const index = Number(model.replace("CONSUMER-", ""));
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index <= 99);
  return Response.json({
    Products: [
      {
        productId: String(index + 1).padStart(32, "0"),
        productNo: model,
        productName: model,
        productCode: consumerGtin(index),
        ProductDetails: [],
      },
    ],
  });
}

function consumerEvent(category: string, conditions: unknown = {}, index = 0) {
  return {
    method: "POST",
    path: "/api/compare",
    query: "",
    headers: { authorization: `Bearer ${monitorSettings.accessToken}` },
    body: JSON.stringify({
      url: `https://item.rakuten.co.jp/shop/consumer-${index}/`,
      category,
      conditions,
      sort: "price",
    }),
  };
}

await test("Rakuten numeric genre IDs preserve source images and auto-detection while rejecting malformed IDs", async (context) => {
  let genreId: unknown = 999901;
  const imageUrl =
    "https://thumbnail.image.rakuten.co.jp/@0_mall/shop/cabinet/product.jpg?_ex=128x128";
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    assert.ok(input instanceof URL);
    if (input.pathname.includes("IchibaGenre/Search")) {
      return Promise.resolve(
        Response.json({ genre: { genreId: 999901 }, ancestors: [{ genreId: 100040 }] }),
      );
    }
    return Promise.resolve(
      Response.json({
        count: 1,
        Items: [
          {
            ...consumerItem(0, "999901", "メモリ: 16GB SSD: 512GB"),
            genreId,
            mediumImageUrls: [imageUrl],
          },
        ],
      }),
    );
  });
  const handler = createApiHandler(false, monitorSettings);
  const event = {
    ...consumerEvent("laptop"),
    path: "/api/detect",
    body: JSON.stringify({ url: "https://item.rakuten.co.jp/shop/consumer-0/" }),
  };
  for (const accepted of [999901, "999901"]) {
    genreId = accepted;
    const response = await handler(event);
    assert.equal(response.statusCode, 200, response.body);
    const body: unknown = JSON.parse(response.body);
    assert.ok(record(body) && record(body["value"]) && record(body["value"]["source"]));
    assert.equal(body["value"]["category"], "laptop");
    assert.equal(body["value"]["source"]["genreId"], "999901");
    assert.equal(body["value"]["source"]["imageUrl"], imageUrl);
  }
  for (const rejected of [-1, 1.5, 1000000, true, [999901], { value: 999901 }]) {
    genreId = rejected;
    const response = await handler(event);
    assert.equal(response.statusCode, 503, response.body);
    assert.match(response.body, /provider_unavailable/);
    assert.equal(response.body.includes(imageUrl), false);
  }
});

await test("all six category APIs extract facts and compare prices without OpenAI or Jev", async (context) => {
  let currentGenre = "100040";
  let paidCalls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    if (!(input instanceof URL) || input.hostname !== "openapi.rakuten.co.jp") {
      paidCalls += 1;
      return Promise.reject(new Error("No paid requests expected"));
    }
    if (input.pathname.includes("Product/Search")) {
      return Promise.resolve(consumerProductResponse(input));
    }
    assert.equal(input.pathname.includes("IchibaItem/Search"), true);
    const caption =
      "CPU: Core i5-1335U\nOS: Windows 11\nメモリ: 16GB\nSSD: 512GB\n画面サイズ: 27インチ\n解像度: 3840×2160\n本体重量: 1.2kg\nリフレッシュレート: 60Hz\nバッテリー容量: 5000mAh\nUSB-C給電: 65W\nUSB-C映像入力: 対応\n高さ調整: あり\nSIMフリー: 対応\nHDMI入力数: 3\nネット動画: 対応";
    const item = consumerItem(
      input.searchParams.has("shopCode") ? 0 : 1,
      currentGenre,
      caption,
      input.searchParams.has("shopCode") ? 80000 : 30000,
    );
    if (!input.searchParams.has("shopCode")) {
      assert.equal(input.searchParams.get("genreId"), currentGenre);
      assert.equal(input.searchParams.has("minPrice"), false);
    }
    return Promise.resolve(Response.json({ count: 1, Items: [item] }));
  });
  for (const category of consumerCategories) {
    const binding = category.providerBindings?.["rakuten"];
    assert.ok(binding !== undefined);
    currentGenre = binding.genreId;
    const handler = createApiHandler(
      false,
      monitorSettings,
      { apiKey: "sk-example-openai-key-1234567890", model: "gpt-6-luna" },
      { apiKey: "example-jev-key", model: "jev-1.13.0" },
    );
    const response = await handler(consumerEvent(category.id));
    assert.equal(response.statusCode, 200, response.body);
    const body: unknown = JSON.parse(response.body);
    assert.ok(record(body) && record(body["value"]) && Array.isArray(body["value"]["products"]));
    const value = body["value"];
    assert.equal(value["category"], category.id);
    assert.deepEqual(value["aiCalls"], { openai: 0, jev: 0 });
    assert.equal(value["status"], "ranked");
    assert.ok(
      record(value["source"]) &&
        record(value["source"]["consumerInformation"]) &&
        record(value["source"]["consumerInformation"]["specs"]),
    );
    assert.deepEqual(
      Object.keys(value["source"]["consumerInformation"]["specs"]),
      category.fields.map((field) => field.id),
    );
    const products: readonly unknown[] = body["value"]["products"];
    assert.deepEqual(
      products.map((product) => (record(product) ? product["rank"] : null)),
      [2, 1],
    );
    assert.equal(response.body.includes(monitorSettings.accessKey), false);
    assert.equal(response.body.includes("ProductDetails"), false);
    const recommended = await handler({
      ...consumerEvent(category.id),
      body: JSON.stringify({
        url: "https://item.rakuten.co.jp/shop/consumer-0/",
        category: category.id,
        conditions: {},
        sort: "recommendation",
      }),
    });
    assert.equal(recommended.statusCode, 200, recommended.body);
    const recommendation: unknown = JSON.parse(recommended.body);
    assert.ok(
      record(recommendation) &&
        record(recommendation["value"]) &&
        Array.isArray(recommendation["value"]["products"]),
    );
    assert.equal(recommendation["value"]["status"], "ranked");
    assert.deepEqual(recommendation["value"]["aiCalls"], { openai: 0, jev: 0 });
    assert.equal(
      recommendation["value"]["products"].every(
        (product: unknown) =>
          record(product) && typeof product["recommendationPercent"] === "number",
      ),
      true,
    );
  }
  assert.equal(paidCalls, 0);
});

await test("candidate exploration refills after condition failures and duplicates, keeps input and uses one Jev Choice batch", async (context) => {
  const pages: number[] = [];
  let jevCalls = 0;
  let genreCalls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.typesafe.ai/v1/systemone") {
      jevCalls += 1;
      assert.ok(typeof options.body === "string");
      const body: unknown = JSON.parse(options.body);
      assert.ok(record(body) && record(body["questions"]));
      assert.equal(body["model"], "jev-1.13.0");
      const answers = Object.fromEntries(
        Object.entries(body["questions"]).map(([id, question]) => {
          assert.ok(
            record(question) && question["type"] === "choice" && record(question["criteria"]),
          );
          const entries = Object.entries(question["criteria"]);
          const selected = entries.find(
            ([key, description]) =>
              key.startsWith("option_") &&
              typeof description === "string" &&
              description.includes(
                String(question["instructions"]).includes("メモリ")
                  ? "候補の値: 16"
                  : "候補の値: 512",
              ),
          );
          assert.ok(selected !== undefined);
          return [
            id,
            {
              type: "choice",
              choice: selected[0],
              confidence: 1,
              probabilities: Object.fromEntries(
                entries.map(([key]) => [key, key === selected[0] ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return Promise.resolve(Response.json({ model: body["model"], answers }));
    }
    assert.ok(
      input instanceof URL && input.hostname === "openapi.rakuten.co.jp",
      "OpenAI is forbidden in consumer flow",
    );
    if (input.pathname.includes("Product/Search")) {
      return Promise.resolve(consumerProductResponse(input));
    }
    if (input.pathname.includes("IchibaGenre/Search")) {
      genreCalls += 1;
      return Promise.resolve(
        Response.json({
          genre: { genreId: "999901", nameJa: "テスト子ジャンル" },
          ancestors: [{ genreId: "100040", nameJa: "ノートPC" }],
        }),
      );
    }
    if (input.searchParams.has("shopCode")) {
      return Promise.resolve(
        Response.json({ count: 1, Items: [consumerItem(0, "999901", "メモリ: 8GB\nSSD: 256GB")] }),
      );
    }
    const page = Number(input.searchParams.get("page"));
    pages.push(page);
    const items =
      page === 1
        ? [
            consumerItem(1, "100040", "メモリ: 8GB", 20000),
            consumerItem(1, "100040", "メモリ: 8GB", 20000),
            consumerItem(0, "999901", "メモリ: 8GB", 81000, "source-copy"),
            consumerItem(2, "100040", "作業領域は16GB、保存領域は512GBです。", 15000),
            consumerItem(3, "100040", "メモリ: 16GB\nSSD: 512GB", 30000),
            consumerItem(0, "999901", "メモリ: 8GB"),
          ]
        : [4, 5, 6, 7, 8].map((index) =>
            consumerItem(index, "100040", "メモリ: 16GB\nSSD: 512GB", 30000 + index * 1000),
          );
    return Promise.resolve(Response.json({ count: 12, Items: items }));
  });
  const handler = createApiHandler(
    false,
    monitorSettings,
    { apiKey: "sk-example-openai-key-1234567890", model: "gpt-6-luna" },
    { apiKey: "example-jev-key", model: "jev-1.13.0" },
  );
  const response = await handler(consumerEvent("laptop", { ramGb: 16 }));
  assert.equal(response.statusCode, 200, response.body);
  const body: unknown = JSON.parse(response.body);
  assert.ok(
    record(body) &&
      record(body["value"]) &&
      record(body["value"]["search"]) &&
      Array.isArray(body["value"]["products"]),
  );
  const value = body["value"];
  assert.deepEqual(pages, [1, 2]);
  assert.equal(genreCalls, 1);
  assert.equal(jevCalls, 1);
  assert.deepEqual(value["aiCalls"], { openai: 0, jev: 1 });
  assert.equal(value["status"], "ranked");
  const searchStats = value["search"];
  const productEntries = value["products"];
  assert.ok(record(searchStats) && Array.isArray(productEntries));
  assert.equal(searchStats["duplicates"], 3);
  const products: readonly unknown[] = productEntries;
  assert.equal(products.length, 6);
  assert.ok(
    record(products[0]) &&
      products[0]["listingId"] === "shop:consumer-0" &&
      products[0]["status"] === "excluded",
  );
  assert.ok(
    record(products[1]) &&
      products[1]["listingId"] === "shop:consumer-2" &&
      products[1]["rank"] === 1,
  );
  assert.equal(
    products.some((product) => record(product) && product["listingId"] === "shop:consumer-1"),
    false,
  );
  assert.equal(response.body.includes("jev_choice"), true);
  assert.equal(response.body.includes('"options"'), false);
});

await test("source lookup uses bounded shop pages and never confuses a keyword match with the requested URL", async (context) => {
  const lookups: string[] = [];
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    assert.ok(input instanceof URL && input.hostname === "openapi.rakuten.co.jp");
    if (input.pathname.includes("Product/Search")) {
      return Promise.resolve(consumerProductResponse(input));
    }
    if (input.searchParams.has("shopCode")) {
      const keyword = input.searchParams.get("keyword") ?? "";
      const page = input.searchParams.get("page") ?? "";
      lookups.push(`${keyword}:${page}`);
      if (keyword === "consumer-0") {
        return Promise.resolve(Response.json({ count: 0, Items: [] }));
      }
      return Promise.resolve(
        Response.json({
          count: 35,
          Items: [consumerItem(page === "1" ? 1 : 0, "100040", "メモリ: 16GB\nSSD: 512GB")],
        }),
      );
    }
    return Promise.resolve(Response.json({ count: 0, Items: [] }));
  });
  const response = await createApiHandler(
    false,
    monitorSettings,
  )(consumerEvent("laptop", { ramGb: 16 }));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(lookups, ["consumer-0:1", "ノートパソコン:1", "ノートパソコン:2"]);
  assert.equal(response.body.includes('"listingId":"shop:consumer-0"'), true);
});

await test("Jev failure, invented choices, low confidence and unknown answers leave missing facts pending", async (context) => {
  let mode = "failure";
  let paidCalls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, options: RequestInit) => {
    if (input === "https://api.typesafe.ai/v1/systemone") {
      paidCalls += 1;
      if (mode === "failure") {
        return Promise.resolve(new Response("Unavailable", { status: 503 }));
      }
      assert.ok(typeof options.body === "string");
      const body: unknown = JSON.parse(options.body);
      assert.ok(record(body) && record(body["questions"]));
      const answers = Object.fromEntries(
        Object.entries(body["questions"]).map(([id, question]) => {
          assert.ok(record(question) && record(question["criteria"]));
          const selected =
            mode === "invented" ? "invented" : mode === "unknown" ? "unknown" : "option_0";
          return [
            id,
            {
              type: "choice",
              choice: selected,
              confidence: mode === "low" ? 0.5 : 1,
              probabilities: Object.fromEntries(
                Object.keys(question["criteria"]).map((key) => [key, key === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return Promise.resolve(Response.json({ model: body["model"], answers }));
    }
    assert.ok(input instanceof URL && input.hostname === "openapi.rakuten.co.jp");
    if (input.pathname.includes("Product/Search")) {
      return Promise.resolve(consumerProductResponse(input));
    }
    return Promise.resolve(
      Response.json(
        input.searchParams.has("shopCode")
          ? {
              count: 1,
              Items: [consumerItem(0, "100040", "作業領域は16GB、保存領域は512GBです。")],
            }
          : { count: 0, Items: [] },
      ),
    );
  });
  const handler = createApiHandler(false, monitorSettings, null, {
    apiKey: "example-jev-key",
    model: "jev-1.13.0",
  });
  for (const failure of ["failure", "invented", "low", "unknown"]) {
    mode = failure;
    const response = await handler(consumerEvent("laptop", { ramGb: 16 }));
    assert.equal(response.statusCode, 200, response.body);
    const body: unknown = JSON.parse(response.body);
    assert.ok(
      record(body) &&
        record(body["value"]) &&
        record(body["value"]["source"]) &&
        record(body["value"]["source"]["consumerInformation"]) &&
        record(body["value"]["source"]["consumerInformation"]["specs"]),
    );
    assert.equal(body["value"]["status"], "needs_information");
    assert.equal(body["value"]["source"]["consumerInformation"]["specs"]["ramGb"], null);
  }
  assert.equal(paidCalls, 4);
  const noJev = await createApiHandler(
    false,
    monitorSettings,
  )(consumerEvent("laptop", { ramGb: 16 }));
  assert.equal(noJev.statusCode, 200, noJev.body);
  assert.equal(noJev.body.includes('"extractionStatus":"not_configured"'), true);
  assert.equal(paidCalls, 4);
});

await test("consumer invalid conditions, category and URL stop before external calls", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", () => {
    calls += 1;
    return Promise.reject(new Error("Unexpected request"));
  });
  const handler = createApiHandler(false, monitorSettings);
  assert.equal((await handler(consumerEvent("gpu"))).statusCode, 400);
  assert.equal((await handler(consumerEvent("laptop", { smartTv: true }))).statusCode, 400);
  assert.equal((await handler(consumerEvent("laptop", { ramGb: "16" }))).statusCode, 400);
  assert.equal((await handler({ ...consumerEvent("laptop"), headers: {} })).statusCode, 401);
  assert.equal(
    (
      await handler({
        ...consumerEvent("laptop"),
        body: JSON.stringify({
          category: "laptop",
          conditions: {},
          sort: "price",
          url: "https://evil.example/product/",
        }),
      })
    ).statusCode,
    422,
  );
  assert.equal(calls, 0);
});
const monitorEvent = {
  method: "POST",
  path: "/api/monitors",
  query: "",
  headers: { authorization: `Bearer ${monitorSettings.accessToken}` },
  body: JSON.stringify({
    url: "https://item.rakuten.co.jp/shop/source/",
    conditions: monitorConditions,
    sort: "price",
  }),
};

await test("monitor authentication and conditions stop invalid requests before any provider calls", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", () => {
    calls += 1;
    return Promise.reject(new Error("Unexpected provider request"));
  });
  const handler = createApiHandler(false, monitorSettings);
  assert.equal((await handler({ ...monitorEvent, headers: {} })).statusCode, 401);
  assert.equal(
    (
      await handler({
        ...monitorEvent,
        body: JSON.stringify({
          url: "https://item.rakuten.co.jp/shop/source/",
          conditions: { ...monitorConditions, usbCPowerW: 55 },
          sort: "price",
        }),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await handler({
        ...monitorEvent,
        body: JSON.stringify({
          url: "https://item.rakuten.co.jp/shop/source/",
          conditions: monitorConditions,
          sort: "ai",
        }),
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 0);
});

await test("monitor API uses the genre filter and cached deterministic facts without OpenAI, even for missing facts", async (context) => {
  const models = ["MONITOR-27A", "MONITOR-27B", "MONITOR-27C"];
  const gtins = ["4549550281836", "4549550281829", "1234567890128"];
  const item = (index: number, slug: string, price: number) => {
    const model = models[index];
    assert.ok(typeof model === "string");
    const canonicalUrl = `https://item.rakuten.co.jp/shop/${slug}/`;
    return {
      itemCode: `shop:${slug}`,
      itemName: `仕事用モニター ${model}`,
      itemUrl: canonicalUrl,
      affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${monitorSettings.affiliateId}/?${new URLSearchParams({ pc: canonicalUrl, m: canonicalUrl }).toString()}`,
      itemCaption: `型番: ${model}`,
      shopCode: "shop",
      shopName: "Example shop",
      itemPriceBaseField: "item_price_min1",
      itemPriceMin1: price,
      itemPriceMax1: price,
      taxFlag: 0,
      postageFlag: 1,
      availability: 1,
      genreId: "110105",
    };
  };
  let productCalls = 0;
  let paidCalls = 0;
  let wrongGenre = false;
  let priceChanged = false;
  context.mock.method(globalThis, "fetch", (input: unknown) => {
    if (!(input instanceof URL) || input.hostname !== "openapi.rakuten.co.jp") {
      paidCalls += 1;
      return Promise.reject(new Error("Monitor flow must not call an AI provider"));
    }
    if (input.pathname.includes("Product/Search")) {
      productCalls += 1;
      const index = models.indexOf(input.searchParams.get("keyword") ?? "");
      assert.ok(index >= 0);
      return Promise.resolve(
        Response.json({
          Products: [
            {
              productId: String(index + 1).repeat(32),
              productNo: models[index],
              productCode: gtins[index],
              productName: models[index],
              ProductDetails: [
                { name: "画面サイズ", value: "27インチ" },
                { name: "解像度", value: "2560×1440" },
                { name: "USB-C給電", value: "65W" },
                ...(index === 2 ? [] : [{ name: "USB-C映像入力", value: "対応" }]),
              ],
            },
          ],
        }),
      );
    }
    const source = { ...item(0, "source", 40_000), genreId: wrongGenre ? "560271" : "110105" };
    const entries = input.searchParams.has("shopCode")
      ? [source]
      : [
          item(1, "cheap", priceChanged ? 18_000 : 20_000),
          item(1, "cheap", priceChanged ? 18_000 : 20_000),
          item(2, "uncertain", 25_000),
          item(0, "source-copy", 42_000),
          { ...item(1, "other-category", 1000), genreId: "560271" },
        ];
    if (!input.searchParams.has("shopCode")) {
      assert.equal(input.searchParams.get("genreId"), "110105");
    }
    assert.equal(input.searchParams.has("minPrice"), false);
    return Promise.resolve(Response.json({ count: entries.length, Items: entries }));
  });
  const handler = createApiHandler(false, monitorSettings, {
    apiKey: "sk-example-openai-key-1234567890",
    model: "gpt-6-luna",
  });
  const response = await handler(monitorEvent);
  assert.equal(response.statusCode, 200, response.body);
  const body: unknown = JSON.parse(response.body);
  assert.ok(record(body) && record(body["value"]) && Array.isArray(body["value"]["products"]));
  const result = body["value"];
  assert.equal(result["status"], "ranked");
  assert.equal(result["aiCalls"], 0);
  assert.ok(record(result["source"]));
  assert.equal(result["source"]["listingId"], "shop:source");
  assert.ok(Array.isArray(result["products"]));
  const products: readonly unknown[] = result["products"];
  assert.deepEqual(
    products.map((product) => (record(product) ? product["listingId"] : null)),
    ["shop:cheap", "shop:uncertain", "shop:source"],
  );
  const cachedCalls = productCalls;
  priceChanged = true;
  const refreshed = await handler(monitorEvent);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(refreshed.body.includes('"minimum":18000'));
  const refreshedBody: unknown = JSON.parse(refreshed.body);
  assert.ok(
    record(refreshedBody) &&
      record(refreshedBody["value"]) &&
      record(refreshedBody["value"]["source"]),
  );
  assert.equal(refreshedBody["value"]["source"]["expiresAt"], result["source"]["expiresAt"]);
  assert.equal(productCalls, cachedCalls);
  const missing = await handler({
    ...monitorEvent,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/source/",
      conditions: { ...monitorConditions, usbCPowerW: 65 },
      sort: "price",
    }),
  });
  assert.equal(missing.statusCode, 200, missing.body);
  const missingBody: unknown = JSON.parse(missing.body);
  assert.ok(
    record(missingBody) &&
      record(missingBody["value"]) &&
      Array.isArray(missingBody["value"]["products"]),
  );
  assert.equal(missingBody["value"]["status"], "needs_information");
  const missingProducts: readonly unknown[] = missingBody["value"]["products"];
  assert.equal(
    missingProducts.every((product) => record(product) && product["rank"] === null),
    true,
  );
  assert.ok(missing.body.includes("usb_c_video_unknown"));
  assert.equal(productCalls, cachedCalls);
  assert.equal(paidCalls, 0);
  assert.equal(response.body.includes(monitorSettings.accessKey), false);
  assert.equal(response.body.includes("ProductDetails"), false);
  wrongGenre = true;
  assert.equal((await handler(monitorEvent)).statusCode, 422);
});

await test("consumer Rakuten adapter preserves evidence through enrichment, uses NGKeyword and skips invalid affiliates", async (context) => {
  let badSource = false;
  let candidateSearches = 0;
  context.mock.method(globalThis, "fetch", (input: unknown): Promise<Response> => {
    if (!(input instanceof URL)) {
      return Promise.reject(new Error("Expected upstream URL"));
    }
    if (input.pathname.includes("IchibaGenre")) {
      return Promise.resolve(
        Response.json({ genre: { genreId: input.searchParams.get("genreId") }, ancestors: [] }),
      );
    }
    if (input.pathname.includes("Product/Search")) {
      const model = input.searchParams.get("keyword") ?? "";
      const index = Number(model.replace("CONSUMER-", ""));
      return Promise.resolve(
        Response.json({
          Products: [
            {
              productId: String(index + 1).padStart(32, "0"),
              productNo: model,
              productName: model,
              productCode: consumerGtin(index),
              ProductDetails: [{ name: "SSD", value: "512GB" }],
            },
          ],
        }),
      );
    }
    const source = {
      ...consumerItem(0, "100040", "メモリ:16GB\n重量:1.2kg"),
      mediumImageUrls: [{ imageUrl: "https://thumbnail.image.rakuten.co.jp/shop/source.jpg" }],
    };
    if (input.searchParams.has("shopCode")) {
      return Promise.resolve(
        Response.json({ count: 1, Items: [badSource ? { ...source, affiliateUrl: "" } : source] }),
      );
    }
    candidateSearches += 1;
    assert.equal(input.searchParams.get("NGKeyword"), "中古 再生品 整備済 展示品 新古品");
    assert.equal(input.searchParams.has("excludeKeyword"), false);
    const good = consumerItem(1, "100040", "メモリ:16GB\n重量:1.1kg", 40_000);
    return Promise.resolve(
      Response.json({
        count: 2,
        Items: [{ ...consumerItem(2, "100040", "", 1), affiliateUrl: "" }, good],
      }),
    );
  });
  const { clock } = jobClock();
  const handler = createApiHandler(false, monitorSettings, null, null, { clock });
  const response = await handler(consumerEvent("laptop"));
  assert.equal(response.statusCode, 200, response.body);
  const body: unknown = JSON.parse(response.body);
  assert.ok(record(body) && record(body["value"]) && record(body["value"]["source"]));
  const result = body["value"];
  const source = result["source"];
  assert.ok(record(source));
  assert.equal(result["storageExpiresAt"], null);
  assert.equal(source["condition"], "new");
  assert.equal(source["identityVerified"], true);
  assert.equal(source["gtin"], consumerGtin(0));
  assert.equal("rakutenProductId" in source, false);
  assert.equal("specifications" in source, false);
  assert.equal(source["imageUrl"], "https://thumbnail.image.rakuten.co.jp/shop/source.jpg");
  const information = source["consumerInformation"];
  assert.ok(
    record(information) && record(information["specs"]) && Array.isArray(information["facts"]),
  );
  assert.equal(information["specs"]["ramGb"], 16);
  assert.equal(information["specs"]["storageGb"], 512);
  const facts: readonly unknown[] = information["facts"];
  assert.equal(
    facts.some(
      (fact) =>
        record(fact) &&
        fact["field"] === "ramGb" &&
        fact["source"] === "rakuten_item_api" &&
        fact["quote"] === "メモリ:16GB",
    ),
    true,
  );
  assert.equal(
    facts.some(
      (fact) =>
        record(fact) && fact["field"] === "storageGb" && fact["source"] === "rakuten_product_api",
    ),
    true,
  );
  assert.ok(Array.isArray(result["products"]));
  const products: readonly unknown[] = result["products"];
  assert.equal(products.length, 2);
  assert.equal(
    products.some((product) => record(product) && product["listingId"] === "shop:consumer-2"),
    false,
  );
  assert.equal(candidateSearches, 1);
  assert.equal(response.body.includes(monitorSettings.accessKey), false);
  const granted = await createApiHandler(
    false,
    { ...monitorSettings, resultStorageAuthorizedUntil: "2026-10-06T12:05:00.000Z" },
    null,
    null,
    { clock },
  )(consumerEvent("laptop"));
  assert.equal(granted.statusCode, 200, granted.body);
  const stored: unknown = JSON.parse(granted.body);
  assert.ok(record(stored) && record(stored["value"]));
  assert.equal(stored["value"]["storageExpiresAt"], "2026-10-06T12:05:00.000Z");
  badSource = true;
  const invalid = await handler(consumerEvent("laptop"));
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.body.includes("invalid_affiliate_url"), true);
});

await test("Rakuten storage grants reject invalid or overlong ISO authorization before any request", () => {
  for (const resultStorageAuthorizedUntil of [
    "2099-01-01T00:00:00.000Z",
    "2026-10-06T12:05:00Z",
    "invalid",
    null,
  ]) {
    assert.throws(() =>
      createApiHandler(false, { ...monitorSettings, resultStorageAuthorizedUntil }),
    );
  }
});

await test("consumer jobs combine cancellation with 8s item and 5s genre timeouts and abort product enrichment", async (context) => {
  const deadlines: AbortSignal[] = [];
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, "timeout", (timeout: number): AbortSignal => {
    const controller = new AbortController();
    timeouts.push(timeout);
    deadlines.push(controller.signal);
    return controller.signal;
  });
  const began = barrier();
  const aborted = barrier();
  const signals: AbortSignal[] = [];
  let requests = 0;
  context.mock.method(
    globalThis,
    "fetch",
    (input: unknown, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!(input instanceof URL) || signal === null || signal === undefined) {
        return Promise.reject(new Error("Expected upstream URL and signal"));
      }
      signals.push(signal);
      requests += 1;
      if (input.pathname.includes("IchibaGenre")) {
        return Promise.resolve(
          Response.json({ genre: { genreId: "999999" }, ancestors: [{ genreId: "100040" }] }),
        );
      }
      if (input.pathname.includes("Product/Search")) {
        began.release();
        return new Promise<Response>((_resolve, reject) => {
          const stop = (): void => {
            aborted.release();
            reject(new Error("Product request aborted"));
          };
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) {
            stop();
          }
        });
      }
      return Promise.resolve(
        Response.json({ count: 1, Items: [consumerItem(0, "999999", "メモリ:16GB")] }),
      );
    },
  );
  const { clock } = jobClock();
  const store = createMemoryComparisonJobStore(clock);
  const handler = createApiHandler(false, monitorSettings, null, null, { clock, jobStore: store });
  const headers = {
    authorization: `Bearer ${monitorSettings.accessToken}`,
    "x-comparison-key": jobKey,
  };
  const accepted = await handler({
    path: "/api/comparisons",
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/consumer-0/",
      category: "laptop",
      conditions: {},
      sort: "price",
      idempotencyKey: "foundation-product-abort",
    }),
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const body: unknown = JSON.parse(accepted.body);
  assert.ok(record(body) && record(body["value"]) && typeof body["value"]["id"] === "string");
  await began.wait;
  assert.deepEqual(timeouts, [8000, 5000, 8000]);
  assert.equal(
    signals.some((signal) => deadlines.includes(signal)),
    false,
  );
  const cancelled = await handler({
    path: `/api/comparisons/${body["value"]["id"]}/cancel`,
    method: "POST",
    headers,
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  await aborted.wait;
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
  assert.equal(requests, 3);
  const terminal = await store.read(body["value"]["id"]);
  assert.ok(terminal.tag === "ok" && terminal.value !== null);
  assert.equal(terminal.value.state, "cancelled");
  assert.equal(terminal.value.result, null);
});

await test("cancellation while Rakuten is pacing prevents the queued genre request", async (context) => {
  const issued = barrier();
  const aborted = barrier();
  let requests = 0;
  context.mock.method(
    globalThis,
    "fetch",
    (input: unknown, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!(input instanceof URL) || signal === null || signal === undefined) {
        return Promise.reject(new Error("Expected upstream URL and signal"));
      }
      requests += 1;
      signal.addEventListener("abort", aborted.release, { once: true });
      issued.release();
      return Promise.resolve(
        Response.json({ count: 1, Items: [consumerItem(0, "999999", "メモリ:16GB")] }),
      );
    },
  );
  const { clock } = jobClock();
  const handler = createApiHandler(false, monitorSettings, null, null, { clock });
  const headers = {
    authorization: `Bearer ${monitorSettings.accessToken}`,
    "x-comparison-key": jobKey,
  };
  const accepted = await handler({
    path: "/api/comparisons",
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/consumer-0/",
      category: "laptop",
      conditions: {},
      sort: "price",
      idempotencyKey: "foundation-pacing-abort",
    }),
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const body: unknown = JSON.parse(accepted.body);
  assert.ok(record(body) && record(body["value"]) && typeof body["value"]["id"] === "string");
  await issued.wait;
  assert.equal(
    (
      await handler({
        path: `/api/comparisons/${body["value"]["id"]}/cancel`,
        method: "POST",
        headers,
      })
    ).statusCode,
    200,
  );
  await aborted.wait;
  assert.equal(requests, 1);
});

await test("a Rakuten request deadline still aborts a job request with an external cancellation signal", async (context) => {
  const deadline = new AbortController();
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, "timeout", (timeout: number): AbortSignal => {
    timeouts.push(timeout);
    return deadline.signal;
  });
  let timeoutReachedRequest = false;
  context.mock.method(
    globalThis,
    "fetch",
    (input: unknown, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!(input instanceof URL) || signal === null || signal === undefined) {
        return Promise.reject(new Error("Expected upstream URL and signal"));
      }
      assert.notEqual(signal, deadline.signal);
      deadline.abort();
      timeoutReachedRequest = signal.aborted;
      return Promise.reject(new Error("Item request timed out"));
    },
  );
  const { clock } = jobClock();
  const underlying = createMemoryComparisonJobStore(clock);
  const finished = barrier();
  const store: ComparisonJobStore = {
    ...underlying,
    finish: async (...args) => {
      const result = await underlying.finish(...args);
      finished.release();
      return result;
    },
  };
  const handler = createApiHandler(false, monitorSettings, null, null, { clock, jobStore: store });
  const headers = {
    authorization: `Bearer ${monitorSettings.accessToken}`,
    "x-comparison-key": jobKey,
  };
  const accepted = await handler({
    path: "/api/comparisons",
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/consumer-0/",
      category: "laptop",
      conditions: {},
      sort: "price",
      idempotencyKey: "foundation-item-timeout",
    }),
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  await finished.wait;
  assert.equal(timeoutReachedRequest, true);
  assert.deepEqual(timeouts, [8000]);
  const body: unknown = JSON.parse(accepted.body);
  assert.ok(record(body) && record(body["value"]) && typeof body["value"]["id"] === "string");
  const terminal = await store.read(body["value"]["id"]);
  assert.ok(terminal.tag === "ok" && terminal.value !== null);
  assert.equal(terminal.value.state, "failed");
  assert.equal(terminal.value.error?.code, "provider_unavailable");
});

await test("consumer job cancellation aborts the optional Jev evidence request with its existing timeout", async (context) => {
  const began = barrier();
  const aborted = barrier();
  const deadlines: AbortSignal[] = [];
  const signals: AbortSignal[] = [];
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, "timeout", (timeout: number): AbortSignal => {
    const controller = new AbortController();
    timeouts.push(timeout);
    deadlines.push(controller.signal);
    return controller.signal;
  });
  context.mock.method(
    globalThis,
    "fetch",
    (input: unknown, init?: RequestInit): Promise<Response> => {
      if (input === "https://api.typesafe.ai/v1/systemone") {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          return Promise.reject(new Error("Expected Jev cancellation signal"));
        }
        signals.push(signal);
        began.release();
        return new Promise<Response>((_resolve, reject) => {
          const stop = (): void => {
            aborted.release();
            reject(new Error("Jev request aborted"));
          };
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) {
            stop();
          }
        });
      }
      if (!(input instanceof URL)) {
        return Promise.reject(new Error("Expected upstream URL"));
      }
      if (input.pathname.includes("IchibaGenre")) {
        return Promise.resolve(
          Response.json({ genre: { genreId: input.searchParams.get("genreId") }, ancestors: [] }),
        );
      }
      if (input.pathname.includes("Product/Search")) {
        return Promise.resolve(consumerProductResponse(input));
      }
      return Promise.resolve(
        Response.json(
          input.searchParams.has("shopCode")
            ? {
                count: 1,
                Items: [consumerItem(0, "100040", "作業領域は16GB、保存領域は512GBです。")],
              }
            : { count: 0, Items: [] },
        ),
      );
    },
  );
  const { clock } = jobClock();
  const handler = createApiHandler(
    false,
    monitorSettings,
    null,
    { apiKey: "jev-example-key", model: "jev-1.13.0" },
    { clock },
  );
  const headers = {
    authorization: `Bearer ${monitorSettings.accessToken}`,
    "x-comparison-key": jobKey,
  };
  const accepted = await handler({
    path: "/api/comparisons",
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/consumer-0/",
      category: "laptop",
      conditions: {},
      sort: "price",
      idempotencyKey: "foundation-jev-abort",
    }),
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const body: unknown = JSON.parse(accepted.body);
  assert.ok(record(body) && record(body["value"]) && typeof body["value"]["id"] === "string");
  await began.wait;
  assert.equal(timeouts.at(-1), 8000);
  assert.equal(
    signals.some((signal) => deadlines.includes(signal)),
    false,
  );
  const cancelled = await handler({
    path: `/api/comparisons/${body["value"]["id"]}/cancel`,
    method: "POST",
    headers,
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  await aborted.wait;
  assert.equal(signals[0]?.aborted, true);
});

const discoveryNow = Date.now();
const discoverySettings = {
  applicationId: "example-app-1234",
  accessKey: "example-access-key-1234567890",
  affiliateId: "11111111.22222222.33333333.44444444",
  allowedOrigin: "https://example-compare.web.app/",
  authorizedUntil: new Date(discoveryNow + 3 * 86_400_000).toISOString(),
  accessToken: "example-test-token-12345678901234567890",
};
const discoveryJevSettings = { apiKey: "test-only-key", model: "jev-1.13.0" };
function discoveryClock(time = discoveryNow): Instant {
  const value = instant(new Date(time).toISOString());
  if (value.tag === "err") {
    throw new Error("Invalid fixture clock");
  }
  return value.value;
}

const discoveryAttributes = [
  { id: 11, label: "総重量" },
  { id: 12, label: "産地（都道府県）" },
  { id: 13, label: "シリーズ名（カナ）" },
];

function discoveryGenreResponse(
  rawAttributes: unknown = discoveryAttributes.map((attribute) => ({
    attributeId: attribute.id,
    nameJa: attribute.label,
  })),
): Response {
  return Response.json({
    genre: { genreId: 201184, nameJa: "白米" },
    ancestors: [{ genreId: 100227 }],
    attributes: rawAttributes,
  });
}

function discoveryRiceItem(id: string, donation = true) {
  const url = `https://item.rakuten.co.jp/shop/${id}/`;
  return {
    itemCode: `shop:${id}`,
    itemName: `${donation ? "【ふるさと納税】" : ""}白米 5kg`,
    itemUrl: url,
    affiliateUrl: `https://hb.afl.rakuten.co.jp/hgc/${discoverySettings.affiliateId}/?${new URLSearchParams({ pc: url }).toString()}`,
    itemCaption:
      "<table><tr><th>総重量</th><td>5kg</td></tr><tr><th>産地</th><td>北海道</td></tr></table>",
    shopCode: "shop",
    shopName: "米の店",
    itemPriceBaseField: "item_price_min1",
    itemPriceMin1: 15000,
    itemPriceMax1: 15000,
    taxFlag: 0,
    postageFlag: 0,
    availability: 1,
    genreId: 201184,
  };
}

await test("automatic category selection rejects malformed Jev responses and malformed attribute dictionaries", async (context) => {
  let answer: unknown = { type: "noul", noul: 0.7 };
  let rawAttributes: unknown = discoveryAttributes
    .slice(0, 2)
    .map((attribute) => ({ attributeId: attribute.id, nameJa: attribute.label }));
  let calls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
    if (input === "https://api.typesafe.ai/v1/systemone") {
      calls += 1;
      assert.ok(typeof init?.body === "string");
      const body: unknown = JSON.parse(init.body);
      assert.ok(record(body) && record(body["questions"]));
      assert.equal(body["model"], "jev-1.13.0");
      for (const question of Object.values(body["questions"])) {
        assert.ok(record(question));
        assert.equal(question["type"], "noul");
      }
      return Promise.resolve(
        Response.json({
          model: "jev-1.13.0",
          answers: Object.fromEntries(Object.keys(body["questions"]).map((id) => [id, answer])),
        }),
      );
    }
    assert.ok(input instanceof URL);
    return Promise.resolve(
      input.pathname.includes("IchibaGenre/Search")
        ? discoveryGenreResponse(rawAttributes)
        : Response.json({ count: 1, Items: [discoveryRiceItem("source")] }),
    );
  });
  const event = {
    method: "POST",
    path: "/api/detect",
    query: "",
    headers: { authorization: `Bearer ${discoverySettings.accessToken}` },
    body: JSON.stringify({ url: "https://item.rakuten.co.jp/shop/source/" }),
  };
  for (const invalid of [
    { type: "choice", noul: 1 },
    { type: "noul", noul: "1" },
    { type: "noul", noul: -0.1 },
    { type: "noul", noul: 1.1 },
    { type: "noul", noul: Number.NaN },
  ]) {
    answer = invalid;
    const response = await createApiHandler(false, discoverySettings, null, discoveryJevSettings, {
      clock: discoveryClock,
    })(event);
    assert.equal(response.statusCode, 200, response.body);
    const body: unknown = JSON.parse(response.body);
    assert.ok(record(body) && record(body["value"]) && record(body["value"]["categoryDefinition"]));
    assert.equal(body["value"]["categorySelectionStatus"], "unavailable");
    assert.deepEqual(body["value"]["categoryDefinition"]["mainFields"], []);
  }
  for (const probability of [0, 0.69, 0.7, 1]) {
    answer = { type: "noul", noul: probability };
    const response = await createApiHandler(false, discoverySettings, null, discoveryJevSettings, {
      clock: discoveryClock,
    })(event);
    const body: unknown = JSON.parse(response.body);
    assert.ok(record(body) && record(body["value"]) && record(body["value"]["categoryDefinition"]));
    assert.equal(body["value"]["categorySelectionStatus"], "applied");
    assert.deepEqual(
      body["value"]["categoryDefinition"]["mainFields"],
      probability >= 0.7 ? ["attribute11", "attribute12"] : [],
    );
  }
  const beforeInvalidDictionary = calls;
  for (const invalid of [
    [{ attributeId: -1, nameJa: "不正" }],
    [
      { attributeId: 11, nameJa: "値" },
      { attributeId: 11, nameJa: "重複" },
    ],
  ]) {
    rawAttributes = invalid;
    const response = await createApiHandler(false, discoverySettings, null, discoveryJevSettings, {
      clock: discoveryClock,
    })(event);
    const body: unknown = JSON.parse(response.body);
    assert.ok(record(body) && record(body["value"]));
    assert.equal(body["value"]["categorySelectionStatus"], "unavailable");
  }
  assert.equal(calls, beforeInvalidDictionary);
});

await test("HTTP comparison unlocks rice, reuses Jev selection, preserves HTML evidence and separates donations from retail", async (context) => {
  let jevCalls = 0;
  context.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
    if (input === "https://api.typesafe.ai/v1/systemone") {
      jevCalls += 1;
      assert.ok(typeof init?.body === "string");
      const body: unknown = JSON.parse(init.body);
      assert.ok(record(body) && record(body["questions"]));
      assert.deepEqual(Object.keys(body["questions"]), ["a11", "a12"]);
      return Promise.resolve(
        Response.json({
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(body["questions"]).map((id) => [id, { type: "noul", noul: 0.7 }]),
          ),
        }),
      );
    }
    assert.ok(
      input instanceof URL && input.hostname === "openapi.rakuten.co.jp",
      "Only Rakuten and Jev may be called",
    );
    if (input.pathname.includes("IchibaGenre/Search")) {
      return Promise.resolve(discoveryGenreResponse());
    }
    if (input.pathname.includes("Product/Search")) {
      return Promise.resolve(Response.json({ Products: [] }));
    }
    if (input.searchParams.has("shopCode")) {
      return Promise.resolve(Response.json({ count: 1, Items: [discoveryRiceItem("source")] }));
    }
    assert.equal(input.searchParams.get("genreId"), "201184");
    assert.equal(input.searchParams.get("keyword"), "ふるさと納税");
    return Promise.resolve(
      Response.json({
        count: 6,
        Items: [
          discoveryRiceItem("retail", false),
          ...Array.from({ length: 5 }, (_, index) => discoveryRiceItem(`candidate${index}`)),
        ],
      }),
    );
  });
  const handler = createApiHandler(false, discoverySettings, null, discoveryJevSettings, {
    clock: discoveryClock,
  });
  const event = {
    method: "POST",
    path: "/api/compare",
    query: "",
    headers: { authorization: `Bearer ${discoverySettings.accessToken}` },
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/source/",
      category: null,
      conditions: {},
      sort: "recommendation",
    }),
  };
  const first = await handler(event);
  assert.equal(first.statusCode, 200, first.body);
  const body: unknown = JSON.parse(first.body);
  assert.ok(record(body) && record(body["value"]));
  const value = body["value"];
  assert.equal(value["category"], "rakuten_201184");
  assert.deepEqual(value["aiCalls"], { openai: 0, jev: 1 });
  assert.equal(value["categorySelectionStatus"], "applied");
  assert.ok(Array.isArray(value["products"]));
  assert.equal(value["products"].length, 6);
  for (const product of value["products"]) {
    assert.ok(record(product) && record(product["consumerInformation"]));
    assert.equal(product["condition"], "unknown");
    assert.equal(product["recommendationPercent"], null);
    assert.notEqual(product["listingId"], "shop:retail");
    assert.deepEqual(product["consumerInformation"]["specs"], {
      attribute11: "5kg",
      attribute12: "北海道",
    });
  }
  const second = await handler({
    ...event,
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/source/",
      category: "rakuten_201184",
      conditions: {},
      sort: "recommendation",
    }),
  });
  assert.equal(second.statusCode, 200, second.body);
  const repeated: unknown = JSON.parse(second.body);
  assert.ok(record(repeated) && record(repeated["value"]));
  assert.deepEqual(repeated["value"]["aiCalls"], { openai: 0, jev: 0 });
  assert.equal(jevCalls, 1);

  const fresh = createApiHandler(false, discoverySettings, null, discoveryJevSettings, {
    clock: discoveryClock,
    dispatchComparisonJob: () => Promise.resolve(),
  });
  const job = await fresh({
    ...event,
    path: "/api/comparisons",
    headers: {
      ...event.headers,
      "x-comparison-key": "example-comparison-key-12345678901234567890",
    },
    body: JSON.stringify({
      url: "https://item.rakuten.co.jp/shop/source/",
      category: "rakuten_201184",
      conditions: {},
      sort: "recommendation",
      idempotencyKey: "new-category-after-restart",
    }),
  });
  assert.equal(job.statusCode, 202, job.body);
});
