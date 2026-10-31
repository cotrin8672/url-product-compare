import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const workspace of ["@app/backend", "@app/api-client"]) {
  const built = spawnSync(
    process.platform === "win32" ? "rtk.exe" : "rtk",
    [
      "mise",
      "exec",
      "--",
      "pnpm",
      "--filter",
      workspace,
      "exec",
      "tsc",
      "--noEmit",
      "false",
      "--outDir",
      "dist",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    built.status,
    0,
    `${workspace} compilation failed\n${built.stdout}\n${built.stderr}`,
  );
}
const { createApiHandler, createPublicConsumerApi } =
  await import("../packages/backend/dist/bootstrap.js");
const { buildConsumerCatalog, defaultConsumerCatalog } =
  await import("../packages/backend/dist/comparison/consumer-catalog.js");
const { readConsumerInformation } = await import("../packages/backend/dist/comparison/consumer.js");
const { createConsumerComparisonService } =
  await import("../packages/backend/dist/comparison/consumer-service.js");
const { createMemoryComparisonJobStore } =
  await import("../packages/backend/dist/infrastructure/jobs/memory.js");
const { createFirestoreComparisonJobStore } =
  await import("../packages/backend/dist/infrastructure/firebase/firestore.js");
const { runComparisonJob, startComparisonJob } =
  await import("../packages/backend/dist/comparison/consumer-jobs.js");
const { ok, err } = await import("../packages/backend/dist/comparison/algebra.js");
const { instant } = await import("../packages/backend/dist/comparison/values.js");
const client = await import("../packages/api-client/dist/index.js");

const serve = process.argv.includes("--serve");
const pcPreview = process.argv.includes("--pc");
assert.ok(!pcPreview || serve, "Use --pc with --serve for the PC UI preview");
const token = "synthetic-review-token-123456789012345678901234567890";
const sampleUrl = "https://shop.example.test/products/source/";
const fanCategory = {
  id: "quiet_fan",
  label: "静音ファン",
  description: "合成データで比較フローを確認します",
  fields: [
    {
      id: "noiseDb",
      label: "動作音",
      unit: "dB",
      kind: "number",
      filter: "max",
      minimum: 0,
      maximum: 100,
      presets: [20, 25, 40],
      extraction: { kind: "numberPattern", pattern: "動作音:\\s*(\\d+(?:\\.\\d+)?)\\s*(dB)" },
    },
  ],
  mainFields: ["noiseDb"],
  axes: [
    { id: "price", label: "価格", lowerIsBetter: true, weight: 1 },
    { id: "noiseDb", label: "静かさ", lowerIsBetter: true, weight: 1 },
  ],
  providerBindings: { synthetic: { genreId: "fan.quiet", keyword: "静音ファン" } },
};
const laptop = defaultConsumerCatalog.category("laptop");
assert.ok(laptop !== null);
const category = pcPreview
  ? { ...laptop, providerBindings: { synthetic: { genreId: "pc.laptop", keyword: "サンプルPC" } } }
  : fanCategory;
const catalog = buildConsumerCatalog([
  ...defaultConsumerCatalog.categories.filter((entry) => entry.id !== category.id),
  category,
]);
const pcSamples = [
  {
    id: "source",
    name: "サンプルPC A",
    description:
      "CPU: Intel Core Ultra 7 155H; GPU: Intel Arc Graphics; CPUコア数: 16コア; CPUスレッド数: 22スレッド; メモリ: 16GB; SSD: 1TB; 重量: 1400g; バッテリー時間: 14時間; バッテリー容量: 72Wh; 解像度: 2560×1600; リフレッシュレート: 120Hz; 輝度: 400nit; USB-A端子数: 2個; USB-C端子数: 2個; OS: Windows 11 Home; Wi-Fi: Wi-Fi 6E; Bluetooth: 5.3; 有線LAN: 非対応; 本体幅: 312mm; 本体高さ: 16mm; 本体奥行: 220mm",
  },
  {
    id: "quiet",
    name: "サンプルPC B",
    description:
      "CPU: AMD Ryzen 7 8840U; GPU: AMD Radeon 780M; CPUコア数: 8コア; CPUスレッド数: 16スレッド; メモリ: 16GB; SSD: 512GB; 重量: 980g; バッテリー時間: 18時間; バッテリー容量: 56Wh; 解像度: 1920×1200; リフレッシュレート: 60Hz; 輝度: 500nit; USB-A端子数: 1個; USB-C端子数: 2個; OS: Windows 11 Home; Wi-Fi: Wi-Fi 6E; Bluetooth: 5.3; 有線LAN: 非対応; 本体幅: 300mm; 本体高さ: 14mm; 本体奥行: 210mm",
  },
  {
    id: "balanced",
    name: "サンプルPC C",
    description:
      "CPU: Intel Core i9-14900HX; GPU: NVIDIA GeForce RTX 4060 Laptop; CPUコア数: 24コア; CPUスレッド数: 32スレッド; GPUメモリ: 8GB; メモリ: 32GB; SSD: 2TB; 重量: 2200g; バッテリー時間: 8時間; バッテリー容量: 90Wh; 解像度: 2560×1600; リフレッシュレート: 165Hz; 輝度: 500nit; USB-A端子数: 3個; USB-C端子数: 2個; OS: Windows 11 Pro; Wi-Fi: Wi-Fi 7; Bluetooth: 5.4; 有線LAN: 対応; 本体幅: 340mm; 本体高さ: 22mm; 本体奥行: 250mm",
  },
  {
    id: "budget",
    name: "サンプルPC D",
    description:
      "CPU: AMD Ryzen 5 7535HS; GPU: NVIDIA GeForce RTX 3050 Laptop; CPUコア数: 6コア; CPUスレッド数: 12スレッド; GPUメモリ: 4GB; メモリ: 8GB; SSD: 256GB; 重量: 1600g; バッテリー時間: 10時間; バッテリー容量: 48Wh; 解像度: 1920×1080; リフレッシュレート: 60Hz; 輝度: 250nit; USB-A端子数: 2個; USB-C端子数: 1個; Wi-Fi: Wi-Fi 6; Bluetooth: 5.2; 有線LAN: 対応; 本体幅: 350mm; 本体高さ: 20mm; 本体奥行: 240mm",
  },
];
let milliseconds = Date.now();
const clock = () => {
  const value = instant(new Date(serve ? Date.now() : milliseconds).toISOString());
  assert.equal(value.tag, "ok");
  return value.value;
};
const listing = (id, price, noise, lifetime = 30_000) => {
  const now = serve ? Date.now() : milliseconds;
  const sample = pcSamples.find((entry) => entry.id === id);
  assert.ok(sample !== undefined);
  return {
    provider: "synthetic",
    mode: "live",
    notice: "動作確認用の架空商品です",
    condition: "new",
    listingId: id,
    title: pcPreview ? sample.name : `新品 静音ファン ${id} 動作音: ${noise}dB`,
    canonicalUrl: `https://shop.example.test/products/${id}/`,
    affiliateUrl: `https://referrals.example.test/visit/${id}?partner=demo`,
    imageUrl: null,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (pcPreview ? 3_600_000 : lifetime)).toISOString(),
    shopName: pcPreview ? "UI確認用サンプル" : "Synthetic shop",
    price: { minimum: price, maximum: price, currency: "JPY" },
    tax: "included",
    shipping: "included",
    availability: "available",
    genreId: category.providerBindings.synthetic.genreId,
    identityVerified: true,
  };
};
let storageGranted = true;
const provider = {
  metadata: {
    id: "synthetic",
    label: "Synthetic shop",
    urlHosts: ["shop.example.test"],
    affiliateHosts: ["referrals.example.test"],
  },
  acceptsUrl: (url) => URL.canParse(url) && new URL(url).hostname === "shop.example.test",
  lookup: (url) =>
    Promise.resolve(
      ok({
        ...listing("source", 40_000, 40),
        ...(url.includes("unsupported") ? { genreId: "unsupported" } : {}),
      }),
    ),
  resolveGenreLineage: () => Promise.resolve([]),
  categoryMatchesLineage: (definition, genreId) =>
    definition.providerBindings?.synthetic?.genreId === genreId,
  search: () =>
    Promise.resolve(
      ok({
        count: 3,
        listings: [
          listing("quiet", 25_000, 20, 25_000),
          listing("balanced", 30_000, 25),
          listing("budget", 20_000, 35),
        ],
      }),
    ),
  enrich: (listings) => Promise.resolve(listings),
  attachConsumerInformation: (entry, definition) => ({
    ...entry,
    consumerInformation: readConsumerInformation(
      definition,
      entry.listingId,
      entry.canonicalUrl,
      pcPreview
        ? (pcSamples.find((sample) => sample.id === entry.listingId)?.description ?? "")
        : entry.title,
      "",
      { listing: "synthetic_offer", product: "synthetic_product" },
    ),
  }),
  permissions: () => ({
    display: true,
    fetch: true,
    affiliate: true,
    ai: false,
    store: storageGranted,
    storeExpiresAt: storageGranted
      ? new Date(
          (serve ? Date.now() : milliseconds) + (pcPreview ? 3_600_000 : 28_000),
        ).toISOString()
      : null,
  }),
};
const service = createConsumerComparisonService([provider], undefined, clock, catalog);
const store = createMemoryComparisonJobStore(clock);
let release = () => undefined;
let held = new Promise((resolveGate) => {
  release = resolveGate;
});
let runnerCalls = 0;
const runner = {
  compare: async (input, options) => {
    runnerCalls += 1;
    await options.onProgress({ stage: "lookup", pages: 0, examined: 0 });
    if (serve) {
      for (let step = 0; step < 5; step += 1) {
        await delay(1000, undefined, { signal: options.signal });
        await options.onProgress({
          stage: "search",
          pages: Math.min(3, step + 1),
          examined: (step + 1) * 3,
        });
      }
    } else {
      await held;
    }
    options.signal.throwIfAborted();
    return await service.compare(input, options);
  },
};
const internalHandler = createApiHandler(false, null, null, null, {
  consumerService: service,
  jobStore: store,
  comparisonRunner: runner,
  clock,
  apiAccessToken: token,
});
const handler = createPublicConsumerApi(internalHandler, {
  accessToken: token,
  allowedOrigin: serve
    ? pcPreview
      ? "http://127.0.0.1:3001"
      : "http://127.0.0.1:5173"
    : "https://fixture.example.test",
  clock: () => (serve ? Date.now() : milliseconds),
});
const originalFetch = globalThis.fetch;
const transport = async (input, init = {}) => {
  const url = new URL(String(input), "https://fixture.example.test");
  assert.equal(
    url.hostname,
    "fixture.example.test",
    "External requests are forbidden in this check",
  );
  const headers = new globalThis.Headers(init.headers);
  if (!url.pathname.endsWith("/cancel")) {
    assert.equal(
      headers.has("authorization"),
      false,
      "Consumer requests must not send a browser token",
    );
  }
  const response = await handler(
    {
      path: url.pathname,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      body: init.body ?? "",
    },
    "synthetic-client",
  );
  return new globalThis.Response(response.statusCode === 204 ? null : response.body, {
    status: response.statusCode,
    headers: response.headers,
  });
};

async function poll(id, options) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await client.readConsumerComparisonJob(id, options);
    if (job.state !== "queued" && job.state !== "running") {
      return job;
    }
    await delay(5);
  }
  throw new Error("The fixture job did not reach a terminal state");
}

async function verifyFirestore() {
  const require = createRequire(new URL("../packages/backend/package.json", import.meta.url));
  const { Timestamp } = require("firebase-admin/firestore");
  const documents = new Map();
  let chain = Promise.resolve();
  const firestore = {
    collection: (name) => {
      assert.equal(name, "comparison_jobs");
      return { doc: (id) => ({ id }) };
    },
    runTransaction: (operation) => {
      const work = chain.then(async () => {
        const writes = [];
        const result = await operation({
          get: (reference) =>
            Promise.resolve({
              exists: documents.has(reference.id),
              data: () => documents.get(reference.id),
            }),
          create: (reference, data) => {
            assert.equal(documents.has(reference.id), false);
            writes.push(() => {
              documents.set(reference.id, data);
            });
          },
          update: (reference, data) => {
            writes.push(() => {
              documents.set(reference.id, { ...documents.get(reference.id), ...data });
            });
          },
        });
        writes.forEach((write) => {
          write();
        });
        return result;
      });
      chain = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
  const durable = createFirestoreComparisonJobStore(clock, firestore);
  const accessKey = client.createComparisonOperation().accessKey;
  const jobInput = {
    url: sampleUrl,
    keyword: null,
    category: category.id,
    conditions: {},
    sort: "price",
  };
  const starts = await Promise.all([
    startComparisonJob(durable, jobInput, "durable-same", accessKey, clock()),
    startComparisonJob(durable, jobInput, "durable-same", accessKey, clock()),
  ]);
  assert.equal(starts.filter((entry) => entry.tag === "ok" && entry.value.created).length, 1);
  assert.equal(starts.filter((entry) => entry.tag === "ok" && !entry.value.created).length, 1);
  const started = starts.find((entry) => entry.tag === "ok");
  assert.ok(started !== undefined);
  const id = started.value.record.id;
  assert.equal(documents.size, 1);
  assert.ok(documents.get(id).cleanupAt instanceof Timestamp);
  assert.equal(JSON.stringify(documents.get(id)).includes(accessKey), false);
  await runComparisonJob(
    durable,
    { compare: async (input, options) => await service.compare(input, options) },
    id,
    "durable-worker",
    clock,
  );
  const finished = await durable.readAuthorized(id, accessKey);
  assert.equal(finished.tag, "ok");
  assert.equal(finished.value.state, "succeeded");
  assert.equal(documents.get(id).cleanupAt.toMillis(), Date.parse(finished.value.resultExpiresAt));
  const valid = documents.get(id);
  documents.set(id, { ...valid, cleanupAt: finished.value.resultExpiresAt });
  assert.deepEqual(await durable.read(id), err({ code: "storage_unavailable" }));
  documents.set(id, { ...valid, expiresAt: "2026-02-30T00:00:00.000Z" });
  assert.deepEqual(await durable.read(id), err({ code: "storage_unavailable" }));
  documents.set(id, {
    ...valid,
    result: { ...valid.result, source: { ...valid.result.source, expiresAt: "invalid" } },
  });
  assert.deepEqual(await durable.read(id), err({ code: "storage_unavailable" }));
  documents.set(id, { ...valid, result: { ...valid.result, storageExpiresAt: null } });
  assert.deepEqual(await durable.read(id), err({ code: "storage_unavailable" }));
  documents.set(id, valid);
  storageGranted = false;
  const deniedApi = createApiHandler(false, null, null, null, {
    consumerService: service,
    jobStore: durable,
    clock,
    apiAccessToken: token,
  });
  const denied = await deniedApi({
    path: "/api/comparisons",
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-comparison-key": accessKey },
    body: JSON.stringify({ ...jobInput, idempotencyKey: "denied" }),
  });
  assert.equal(denied.statusCode, 422);
  assert.equal(JSON.parse(denied.body).error.code, "result_storage_denied");
  assert.equal(documents.size, 1, "Denied storage must stop before queue creation");
  const deniedStart = await startComparisonJob(
    durable,
    jobInput,
    "denied-worker",
    accessKey,
    clock(),
  );
  assert.equal(deniedStart.tag, "ok");
  await runComparisonJob(
    durable,
    { compare: async (input, options) => await service.compare(input, options) },
    deniedStart.value.record.id,
    "worker",
    clock,
  );
  const deniedResult = await durable.read(deniedStart.value.record.id);
  assert.equal(deniedResult.value.state, "failed");
  assert.equal(deniedResult.value.error.code, "result_storage_denied");
  assert.equal(documents.get(deniedStart.value.record.id).result, null);
  storageGranted = true;
}

async function verify() {
  globalThis.fetch = transport;
  try {
    client.resetConsumerCatalogCache();
    const apiOptions = {};
    const metadata = await client.fetchProductCatalog(apiOptions);
    assert.ok(metadata.categories.some((entry) => entry.id === category.id));
    assert.deepEqual(metadata.providers, [provider.metadata]);
    const detected = await client.detectProductCategory(sampleUrl, apiOptions);
    assert.equal(detected.category, category.id);
    const unsupported = await client.detectProductCategory(
      "https://shop.example.test/products/unsupported/",
      apiOptions,
    );
    assert.equal(unsupported.status, "unsupported");
    assert.ok(
      unsupported.source !== null,
      "Unsupported categories retain recovered listing metadata",
    );
    const operation = client.createComparisonOperation();
    const options = { ...apiOptions, comparisonKey: operation.accessKey };
    const input = {
      url: sampleUrl,
      category: category.id,
      conditions: { noiseDb: 25 },
      sort: "price",
      idempotencyKey: operation.idempotencyKey,
    };
    const timeout = new globalThis.AbortController();
    const timing = globalThis.setTimeout(() => {
      timeout.abort();
      release();
    }, 500);
    let queued;
    try {
      queued = await client.startConsumerComparisonJob(input, {
        ...options,
        signal: timeout.signal,
      });
      assert.equal(timeout.signal.aborted, false, "POST waited for the blocked runner");
    } finally {
      globalThis.clearTimeout(timing);
    }
    assert.equal(queued.state, "queued");
    const current = await client.readConsumerComparisonJob(queued.id, options);
    assert.equal(current.accessKey, operation.accessKey);
    assert.equal(current.state, "running");
    assert.equal(current.stage, "lookup");
    const recovered = await client.startConsumerComparisonJob(input, options);
    assert.equal(recovered.id, queued.id);
    assert.equal(recovered.accessKey, operation.accessKey);
    assert.equal(runnerCalls, 1);
    await assert.rejects(
      client.readConsumerComparisonJob(queued.id, {
        ...options,
        comparisonKey: client.createComparisonOperation().accessKey,
      }),
    );
    const cancelled = await client.cancelConsumerComparisonJob(queued.id, {
      ...options,
      accessToken: token,
    });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.accessKey, operation.accessKey);
    release();
    const cancelledAgain = await poll(queued.id, options);
    assert.equal(cancelledAgain.state, "cancelled");
    held = Promise.resolve();
    const successOperation = client.createComparisonOperation();
    const successOptions = { ...apiOptions, comparisonKey: successOperation.accessKey };
    const succeeding = await client.startConsumerComparisonJob(
      { ...input, category: null, idempotencyKey: successOperation.idempotencyKey },
      successOptions,
    );
    const success = await poll(succeeding.id, successOptions);
    assert.equal(success.state, "succeeded");
    assert.equal(success.result.category, category.id);
    assert.equal(success.result.conditions.noiseDb, 25);
    assert.equal(success.result.products.length, 4);
    assert.ok(success.result.products.some((entry) => entry.rank === 1));
    assert.ok(
      success.result.products.every((entry) =>
        entry.consumerInformation.facts.some((fact) => fact.source === "synthetic_offer"),
      ),
    );
    assert.equal(success.expiresAt, new Date(milliseconds + 25_000).toISOString());
    const winningFinish = await client.cancelConsumerComparisonJob(success.id, {
      ...successOptions,
      accessToken: token,
    });
    assert.equal(winningFinish.state, "succeeded");
    assert.deepEqual(winningFinish.result, success.result);
    const repeated = await client.startConsumerComparisonJob(
      { ...input, category: null, idempotencyKey: successOperation.idempotencyKey },
      successOptions,
    );
    assert.equal(repeated.id, success.id);
    assert.equal(repeated.state, "succeeded");
    await verifyFirestore();
    milliseconds += 25_001;
    await assert.rejects(client.readConsumerComparisonJob(success.id, successOptions), /有効期限/);
    assert.equal((await store.read(success.id)).value.result, null);
    console.log(
      "Comparison flow: real service -> public bootstrap -> token-free compiled client; catalog, detect, fast 202, retry, poll, protected cancellation, auto-category, success, expiry and native Firestore TTL/storage guards passed without network.",
    );
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
}

async function serveFixture() {
  if (pcPreview) {
    const compared = await service.compare({
      url: sampleUrl,
      keyword: null,
      category: category.id,
      conditions: {},
      sort: "recommendation",
    });
    assert.equal(compared.tag, "ok");
    const checkedCatalog = client.parseProductCatalog({
      tag: "ok",
      value: { categories: service.catalog(), providers: compared.value.providerDefinitions },
    });
    const parsed = client.parseConsumerComparison(compared, checkedCatalog);
    assert.equal(parsed.products.length, 4);
    assert.equal(parsed.status, "ranked");
    const layout = client.comparisonDetailLayout(parsed.categoryDefinition, parsed.products);
    assert.equal(layout.primaryAxes.length, 6);
    assert.ok(layout.detailAxes.length > 0);
    assert.equal(parsed.source.consumerInformation.specs["gpuVramGb"], null);
    assert.ok(
      parsed.products.some((product) =>
        product.axes.some((axis) => axis.id === "gpuVramGb" && axis.score === null),
      ),
    );
    assert.ok(
      parsed.products.some((product) =>
        product.axes.some((axis) => axis.id === "gpuVramGb" && axis.score !== null),
      ),
    );
    console.log(
      `PC sample validated: 4 products, 6 primary axes, ${layout.detailAxes.length} extra axes, ${layout.specificationFields.length} specification rows`,
    );
  }
  const webRoot = resolve(root, "apps/products/dist");
  const tasks = new Set();
  const handle = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:3001");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      const result = await handler(
        {
          path: url.pathname,
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        },
        request.socket.remoteAddress ?? "unknown",
      );
      response.writeHead(result.statusCode, result.headers);
      response.end(result.statusCode === 204 ? "" : result.body);
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const target = resolve(webRoot, `.${pathname}`, pathname.endsWith("/") ? "index.html" : "");
    const inside = relative(webRoot, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body;
    let extension = extname(target);
    try {
      body = await readFile(target);
    } catch {
      if (extension !== "" && extension !== ".html") {
        response.writeHead(404);
        response.end();
        return;
      }
      body = await readFile(resolve(webRoot, "index.html"));
      extension = ".html";
    }
    response.writeHead(200, {
      "content-type":
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  };
  const server = createServer((request, response) => {
    const work = handle(request, response)
      .catch(() => {
        response.writeHead(500);
        response.end("Fixture unavailable");
      })
      .finally(() => {
        tasks.delete(work);
      });
    tasks.add(work);
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(3001, "127.0.0.1", resolveReady);
  });
  console.log(`Synthetic fixture: http://127.0.0.1:3001\nProduct URL: ${sampleUrl}`);
}
if (serve) {
  await serveFixture();
} else {
  await verify();
}
