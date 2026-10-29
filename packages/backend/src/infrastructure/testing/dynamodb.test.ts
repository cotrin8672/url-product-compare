import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import { createConsumerCategoryDiscovery } from "../../comparison/consumer-discovery.js";
import { startComparisonJob } from "../../comparison/consumer-jobs.js";
import type { ComparisonJobInput } from "../../comparison/consumer-jobs.js";
import { instant } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";
import {
  createLambdaApi,
  createLambdaCleanup,
  lambdaStorageConfiguration,
} from "../../lambda-bootstrap.js";
import { createDynamoCategoryCache } from "../dynamodb/categories.js";
import { decodeDynamoPayload, encodeDynamoPayload } from "../dynamodb/codec.js";
import { createDynamoDatabase } from "../dynamodb/database.js";
import type { DynamoDatabase, DynamoItem, DynamoSend } from "../dynamodb/database.js";
import { createDynamoComparisonJobStore } from "../dynamodb/jobs.js";
import { createDynamoRateLimiter } from "../dynamodb/limits.js";

type Tables = Readonly<{ jobs: string; categories: string; limits: string }>;
const tables: Tables = { jobs: "jobs", categories: "categories", limits: "limits" };

// Atomic, deterministic port fake; the same contracts also run against DynamoDB Local below.
function memoryDatabase(): DynamoDatabase {
  const rows = new Map<string, DynamoItem>();
  const counters = new Map<string, number>();
  const key = (table: string, id: string): string => `${table}/${id}`;
  return {
    get: (table, id) => Promise.resolve(rows.get(key(table, id)) ?? null),
    put: (table, item, condition) => {
      const previous = rows.get(key(table, item.key));
      const valid =
        condition.kind === "absent"
          ? previous === undefined
          : condition.kind === "revision"
            ? previous?.revision === condition.revision &&
              previous.generation === condition.generation
            : previous?.leaseOwner === condition.owner &&
              (previous.leaseUntil ?? 0) > condition.now;
      if (valid) {
        rows.set(key(table, item.key), structuredClone(item));
      }
      return Promise.resolve(valid);
    },
    remove: (table, id, revision, generation) => {
      const previous = rows.get(key(table, id));
      const valid = previous?.revision === revision && previous.generation === generation;
      if (valid) {
        rows.delete(key(table, id));
      }
      return Promise.resolve(valid);
    },
    claim: (table, id, owner, now, until) => {
      const previous = rows.get(key(table, id));
      const valid =
        (previous?.leaseUntil ?? 0) <= now &&
        (previous?.data === undefined || (previous.freshUntil ?? Infinity) <= now);
      if (valid) {
        rows.set(key(table, id), {
          key: id,
          revision: 0,
          ttl: Math.ceil(until / 1000) + 60,
          leaseOwner: owner,
          leaseUntil: until,
        });
      }
      return Promise.resolve(valid);
    },
    release: (table, id, owner) => {
      if (rows.get(key(table, id))?.leaseOwner === owner) {
        rows.delete(key(table, id));
      }
      return Promise.resolve();
    },
    consume: (table, entries) => {
      if (entries.some((entry) => (counters.get(key(table, entry.key)) ?? 0) >= entry.limit)) {
        return Promise.resolve(false);
      }
      for (const entry of entries) {
        counters.set(key(table, entry.key), (counters.get(key(table, entry.key)) ?? 0) + 1);
      }
      return Promise.resolve(true);
    },
    count: (table, id) => {
      counters.set(key(table, id), (counters.get(key(table, id)) ?? 0) + 1);
      return Promise.resolve();
    },
    due: (table, now, limit) =>
      Promise.resolve(
        [...rows.entries()]
          .filter(
            ([id, item]) =>
              id.startsWith(`${table}/`) && item.dueAt !== undefined && item.dueAt <= now,
          )
          .sort((left, right) => (left[1].dueAt ?? 0) - (right[1].dueAt ?? 0))
          .slice(0, limit)
          .map(([, item]) => item.key),
      ),
  };
}

function time(value: number): Instant {
  const parsed = instant(new Date(value).toISOString());
  assert.equal(parsed.tag, "ok");
  return parsed.value;
}

async function jobsContract(database: DynamoDatabase, names: Tables): Promise<void> {
  let now = Date.parse("2026-10-24T00:00:00.000Z");
  const store = createDynamoComparisonJobStore(database, names.jobs, () => time(now));
  const input: ComparisonJobInput = {
    url: "https://example.test/source",
    category: "laptop",
    keyword: null,
    conditions: {},
    sort: "price",
  };
  const key = "k".repeat(36);
  const starts = await Promise.all(
    [0, 1].map(
      async () => await startComparisonJob(store, input, "same-operation", key, time(now)),
    ),
  );
  assert.equal(starts.filter((entry) => entry.tag === "ok" && entry.value.created).length, 1);
  const created = starts.find((entry) => entry.tag === "ok");
  assert.ok(created !== undefined);
  const id = created.value.record.id;
  assert.deepEqual(await store.readAuthorized(id, "wrong"), {
    tag: "err",
    error: { code: "job_forbidden" },
  });
  const duplicate = await startComparisonJob(store, input, "same-operation", key, time(now));
  assert.equal(duplicate.tag, "ok");
  assert.equal(duplicate.value.created, false);
  const conflict = await startComparisonJob(
    store,
    { ...input, keyword: "changed" },
    "same-operation",
    key,
    time(now),
  );
  assert.equal(conflict.tag, "err");
  assert.equal(conflict.error.code, "idempotency_conflict");
  const claims = await Promise.all(
    ["worker-a", "worker-b"].map(
      async (worker) => await store.claim(id, worker, new Date(now + 45_000).toISOString()),
    ),
  );
  assert.equal(claims.filter((entry) => entry.tag === "ok").length, 1);
  const claim = claims.find((entry) => entry.tag === "ok");
  assert.ok(claim !== undefined && claim.value.workerId !== null);
  assert.deepEqual(
    await store.progress(id, "stale-worker", claim.value.revision, {
      stage: "search",
      progress: { pages: 1, examined: 2 },
    }),
    { tag: "err", error: { code: "revision_conflict" } },
  );
  const expiry = new Date(now + 60_000).toISOString();
  const finished = await store.finish(id, claim.value.workerId, claim.value.revision, {
    kind: "succeeded",
    result: { items: ["product"], storageExpiresAt: expiry },
    resultExpiresAt: expiry,
    storageExpiresAt: expiry,
  });
  assert.equal(finished.tag, "ok");
  assert.equal(finished.value.state, "succeeded");
  now += 60_001;
  const expired = await store.readAuthorized(id, key);
  assert.deepEqual(expired, { tag: "err", error: { code: "job_expired" } });
  const physical = await store.read(id);
  assert.equal(physical.tag, "ok");
  assert.equal(physical.value?.result, null);

  for (const scenario of ["cancel", "permission", "large", "orphan"]) {
    const start = await startComparisonJob(store, input, scenario, key, time(now));
    assert.equal(start.tag, "ok");
    const job = start.value.record;
    if (scenario === "orphan") {
      continue;
    }
    const worker = await store.claim(job.id, "worker", new Date(now + 45_000).toISOString());
    assert.equal(worker.tag, "ok");
    if (scenario === "cancel") {
      const cancelled = await store.cancel(job.id, key);
      assert.equal(cancelled.tag, "ok");
      assert.equal(cancelled.value.state, "cancelled");
      const late = await store.finish(job.id, "worker", worker.value.revision, {
        kind: "failed",
        error: { code: "late" },
      });
      assert.equal(late.tag, "ok");
      assert.equal(late.value.state, "cancelled");
    } else {
      const result = {
        items: scenario === "large" ? [randomBytes(370_000).toString("base64")] : [],
        storageExpiresAt: new Date(now + 60_000).toISOString(),
      };
      const completed = await store.finish(job.id, "worker", worker.value.revision, {
        kind: "succeeded",
        result,
        resultExpiresAt: new Date(now + 60_000).toISOString(),
        storageExpiresAt: scenario === "permission" ? null : new Date(now + 60_000).toISOString(),
      });
      assert.equal(completed.tag, "ok");
      assert.equal(completed.value.state, "failed");
      assert.equal(completed.value.result, null);
      assert.equal(
        completed.value.error?.code,
        scenario === "large" ? "result_too_large" : "result_storage_denied",
      );
    }
  }
  now += 600_001;
  await store.cleanup();
  const orphan = await startComparisonJob(store, input, "orphan", key, time(now));
  assert.equal(orphan.tag, "ok");
  assert.equal(orphan.value.record.error?.code, "job_interrupted");
  now += 3_600_000;
  await store.cleanup();
  assert.equal(await database.get(names.jobs, id), null);

  // Revision alone is insufficient after TTL deletion/recreation of the same key.
  const row = { key: "a".repeat(64), revision: 1, ttl: 2_000_000_000, generation: "new" };
  assert.equal(await database.put(names.jobs, row, { kind: "absent" }), true);
  assert.equal(
    await database.put(
      names.jobs,
      { ...row, revision: 2 },
      { kind: "revision", revision: 1, generation: "old" },
    ),
    false,
  );
  assert.equal(await database.remove(names.jobs, row.key, 1, "old"), false);
}

async function cacheContract(database: DynamoDatabase, names: Tables): Promise<void> {
  let now = Date.parse("2026-10-24T00:00:00.000Z");
  let aiAllowed = true;
  let calls = 0;
  const cache = createDynamoCategoryCache(database, names.categories);
  const discovery = (version: string) =>
    createConsumerCategoryDiscovery(
      "rakuten",
      () =>
        Promise.resolve({ id: "100", label: "Laptop", attributes: [{ id: 1, label: "Memory" }] }),
      async () => {
        calls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return { tag: "ok", value: [1] };
      },
      () => time(now),
      () => ({
        fetch: true,
        display: true,
        affiliate: true,
        ai: aiAllowed,
        store: true,
        storeExpiresAt: new Date(now + 86_400_000).toISOString(),
      }),
      { store: cache, version },
    );
  const pair = await Promise.all([discovery("v1")("100"), discovery("v1")("100")]);
  assert.equal(calls, 1);
  assert.equal(
    pair.every((entry) => entry?.status === "applied"),
    true,
  );
  assert.equal(
    pair.reduce((sum, entry) => sum + (entry?.aiCalls ?? 0), 0),
    1,
  );
  assert.equal((await discovery("v1")("100"))?.aiCalls, 0);
  await discovery("v2")("100");
  assert.equal(calls, 2);
  aiAllowed = false;
  assert.equal((await discovery("v1")("100"))?.status, "not_configured");
  assert.equal(calls, 2);
  aiAllowed = true;
  now += 86_400_001;
  assert.equal((await discovery("v1")("100"))?.aiCalls, 1);
  assert.equal(calls, 3);
  assert.equal(await cache.claim("lease", "old", now, now + 10), true);
  assert.equal(await cache.claim("lease", "new", now + 11, now + 1000), true);
  const entry = {
    genreId: "100",
    label: "Laptop",
    attributes: [{ id: 1, label: "Memory" }],
    majorIds: [1],
    status: "applied",
    expiresAt: new Date(now + 60_000).toISOString(),
  } satisfies NonNullable<Awaited<ReturnType<typeof cache.read>>>;
  assert.equal(await cache.publish("lease", "old", entry, now + 12), false);
  await cache.release("lease", "old");
  assert.equal(await cache.publish("lease", "new", entry, now + 12), true);
  await cache.release("lease", "new");
  assert.deepEqual(await cache.read("lease"), entry);
  const broken = {
    ...database,
    get: () => Promise.reject(new Error("private database failure")),
  } satisfies DynamoDatabase;
  const unavailable = createConsumerCategoryDiscovery(
    "rakuten",
    () => Promise.reject(new Error("must not call provider")),
    () => Promise.reject(new Error("must not charge AI")),
    () => time(now),
    () => ({
      fetch: true,
      display: true,
      affiliate: true,
      ai: true,
      store: true,
      storeExpiresAt: new Date(now + 86_400_000).toISOString(),
    }),
    { store: createDynamoCategoryCache(broken, names.categories), version: "v1" },
  );
  assert.equal(await unavailable("100"), null);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(discovery("v1")("100", { signal: abort.signal }));
}

async function limitsContract(database: DynamoDatabase, names: Tables): Promise<void> {
  let now = Date.parse("2026-10-24T00:00:00.000Z");
  const limit = createDynamoRateLimiter(database, names.limits, () => now, {
    perMinute: 8,
    perDay: 9,
  });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(await limit("a".repeat(64)), true);
  }
  assert.equal(await limit("a".repeat(64)), false);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await limit("b".repeat(64)), true);
  }
  assert.equal(await limit("c".repeat(64)), false);
  now += 60_000;
  assert.equal(await limit("a".repeat(64)), true);
  assert.equal(await limit("b".repeat(64)), false);
  now += 86_400_000;
  assert.equal(await limit("a".repeat(64)), true);
  assert.deepEqual(
    await Promise.all(["b", "c", "d", "e"].map(async (id) => await limit(id.repeat(64)))),
    [true, true, true, true],
  );
  await assert.rejects(limit("192.0.2.1"));
}

await test("DynamoDB ports preserve job capabilities, worker fencing, expiry, cancellation and bounded results", async () => {
  await jobsContract(memoryDatabase(), tables);
});
await test("shared category cache deduplicates paid AI across instances, fences leases and respects grants", async () => {
  await cacheContract(memoryDatabase(), tables);
});
await test("atomic address/minute/day limits preserve counters after rejection", async () => {
  await limitsContract(memoryDatabase(), tables);
});
await test("DynamoDB codec rejects corrupt, unbounded and non-JSON payloads", () => {
  assert.deepEqual(decodeDynamoPayload(encodeDynamoPayload({ text: "x".repeat(500_000) })), {
    text: "x".repeat(500_000),
  });
  assert.throws(() => encodeDynamoPayload(undefined));
  assert.throws(() => encodeDynamoPayload("x".repeat(600_000)));
  assert.throws(() => decodeDynamoPayload(new Uint8Array([1, 2, 3])));
});
await test("DynamoDB transport validates AWS responses and never treats outages as authorization", async () => {
  const invalid = createDynamoDatabase(() =>
    Promise.resolve({
      Item: { key: { S: "key" }, revision: { N: "not-a-number" }, ttl: { N: "10" } },
    }),
  );
  await assert.rejects(invalid.get("table", "key"));
  const unavailable = createDynamoDatabase(() => Promise.reject(new Error("private")));
  await assert.rejects(unavailable.consume("table", [{ key: "counter", limit: 1, ttl: 10 }]));
});
await test("transaction conflict retry preserves the idempotency token and stops on an actual limit", async () => {
  const tokens: unknown[] = [];
  const database = createDynamoDatabase((command) => {
    assert.ok("ClientRequestToken" in command.input);
    tokens.push(command.input.ClientRequestToken);
    return tokens.length < 3
      ? Promise.reject(
          Object.assign(new Error("Transaction conflict"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "TransactionConflict" }],
          }),
        )
      : Promise.resolve({});
  });
  assert.equal(await database.consume("table", [{ key: "counter", limit: 1, ttl: 10 }]), true);
  assert.equal(tokens.length, 3);
  assert.equal(new Set(tokens).size, 1);
  const denied = createDynamoDatabase(() =>
    Promise.reject(
      Object.assign(new Error("Counter limit"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      }),
    ),
  );
  assert.equal(await denied.consume("table", [{ key: "counter", limit: 1, ttl: 10 }]), false);
});

const endpoint = process.env["DYNAMODB_LOCAL_ENDPOINT"];
await test("Lambda wiring uses shared limits, rejects legacy PHP settings and isolates cleanup events", async () => {
  let admitted = 0;
  const memory = memoryDatabase();
  const database = {
    ...memory,
    consume: async (table, counters) => {
      admitted += 1;
      assert.equal(
        counters.some((counter) => counter.key.includes("192.0.2.1")),
        false,
      );
      return await memory.consume(table, counters);
    },
  } satisfies DynamoDatabase;
  const settings = {
    rakuten: {
      applicationId: "example-app-1234",
      accessKey: "example-access-key-1234567890",
      affiliateId: "11111111.22222222.33333333.44444444",
      allowedOrigin: "https://consumer.example/",
      authorizedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    openai: null,
    http: { accessToken: "t".repeat(36), allowedOrigin: "https://consumer.example" },
  };
  const worker = "arn:aws:lambda:ap-northeast-1:123456789012:function:worker";
  const api = createLambdaApi(settings, worker, tables, database);
  const event = {
    version: "2.0",
    rawPath: "/api/commerce",
    rawQueryString: "",
    isBase64Encoded: false,
    headers: { origin: settings.http.allowedOrigin, "content-type": "application/json" },
    requestContext: { http: { method: "POST", sourceIp: "192.0.2.1" } },
    body: "{}",
  };
  assert.equal(
    (await api({ ...event, headers: { ...event.headers, origin: "https://unexpected.invalid" } }))
      .statusCode,
    403,
  );
  assert.equal(admitted, 0);
  assert.equal((await api(event)).statusCode, 400);
  assert.equal(admitted, 1);
  assert.throws(() => createLambdaApi({ ...settings, storage: {} }, worker, tables, database));
  assert.throws(() => lambdaStorageConfiguration({ ...tables, categories: tables.jobs }));
  const cleanup = createLambdaCleanup(tables.jobs, database);
  await cleanup({ kind: "cleanup" });
  await assert.rejects(cleanup({ kind: "cleanup", jobId: "a".repeat(64) }));
});
await test(
  "official SDK + DynamoDB Local exercise actual condition expressions, transactions and cleanup GSI",
  { skip: endpoint === undefined },
  async (context) => {
    assert.ok(
      endpoint !== undefined && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint),
      "Only an explicit loopback DynamoDB Local endpoint is permitted",
    );
    const client = new DynamoDBClient({
      endpoint,
      region: "ap-northeast-1",
      credentials: { accessKeyId: "localtest", secretAccessKey: "localtest" },
      maxAttempts: 2,
    });
    const send: DynamoSend = async (command, signal) => {
      const options = { abortSignal: signal };
      if (command instanceof GetItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof PutItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof DeleteItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof UpdateItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof QueryCommand) {
        return await client.send(command, options);
      }
      return await client.send(command, options);
    };
    const prefix = `compare_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const names: Tables = {
      jobs: `${prefix}_jobs`,
      categories: `${prefix}_categories`,
      limits: `${prefix}_limits`,
    };
    const created: string[] = [];
    try {
      for (const name of Object.values(names)) {
        await client.send(
          new CreateTableCommand({
            TableName: name,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: [{ AttributeName: "key", KeyType: "HASH" }],
            AttributeDefinitions: [
              { AttributeName: "key", AttributeType: "S" },
              ...(name === names.jobs
                ? ([
                    { AttributeName: "cleanupGroup", AttributeType: "S" },
                    { AttributeName: "dueAt", AttributeType: "N" },
                  ] satisfies NonNullable<
                    ConstructorParameters<typeof CreateTableCommand>[0]["AttributeDefinitions"]
                  >)
                : []),
            ],
            ...(name === names.jobs
              ? {
                  GlobalSecondaryIndexes: [
                    {
                      IndexName: "cleanup",
                      KeySchema: [
                        { AttributeName: "cleanupGroup", KeyType: "HASH" },
                        { AttributeName: "dueAt", KeyType: "RANGE" },
                      ],
                      Projection: { ProjectionType: "KEYS_ONLY" },
                    },
                  ],
                }
              : {}),
          }),
        );
        created.push(name);
      }
      const database = createDynamoDatabase(send);
      await context.test("job store", async () => {
        await jobsContract(database, names);
      });
      await context.test("shared category cache", async () => {
        await cacheContract(database, names);
      });
      await context.test("transactional rate limits", async () => {
        await limitsContract(database, names);
      });
    } finally {
      for (const name of created) {
        await client.send(new DeleteTableCommand({ TableName: name }));
      }
      client.destroy();
    }
  },
);
