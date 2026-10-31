import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiHandler, createPublicConsumerApi } from "../../bootstrap.js";
import { createConsumerComparisonService } from "../../comparison/consumer-service.js";
import { instant, record } from "../../comparison/values.js";
import {
  combineLambdaConfiguration,
  createLambdaApi,
  createLambdaWorker,
} from "../../lambda-bootstrap.js";
import { createLambdaHttpHandler } from "../aws/http.js";
import { createLambdaDispatcher } from "../aws/invoke.js";
import { apiResponse } from "../http/request.js";
import { createMemoryComparisonJobStore } from "../jobs/memory.js";

const event = {
  version: "2.0",
  rawPath: "/api/detect",
  rawQueryString: "",
  isBase64Encoded: false,
  headers: {
    origin: "https://consumer.example",
    "content-type": "application/json",
    "x-forwarded-for": "spoofed",
  },
  requestContext: { http: { method: "POST", sourceIp: "192.0.2.1" } },
  body: JSON.stringify({ url: "https://item.rakuten.co.jp/shop/product/" }),
};
const tables = {
  jobs: "comparison-jobs",
  categories: "comparison-categories",
  limits: "comparison-limits",
};

await test("multiple site origins pass CORS independently while unlisted origins remain forbidden", async () => {
  const origins = [
    "https://products.example",
    "https://furusato.example",
    "https://securities.example",
  ];
  const api = createPublicConsumerApi(() => Promise.resolve(apiResponse(200, { tag: "ok" })), {
    accessToken: "t".repeat(36),
    allowedOrigin: "https://products.example",
    allowedOrigins: origins,
  });
  for (const origin of origins) {
    for (const method of ["GET", "OPTIONS"]) {
      const response = await api(
        { path: "/api/catalog", method, headers: { origin, "sec-fetch-site": "cross-site" } },
        "192.0.2.1",
      );
      assert.equal(response.statusCode, method === "OPTIONS" ? 204 : 200);
      assert.equal(response.headers["access-control-allow-origin"], origin);
      assert.equal(response.headers["vary"]?.includes("Origin"), true);
    }
  }
  for (const origin of ["https://evil.example", "https://products.example.evil", "null"]) {
    const response = await api(
      { path: "/api/catalog", method: "OPTIONS", headers: { origin } },
      "192.0.2.1",
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  for (const allowedOrigins of [
    [],
    ["*"],
    ["https://products.example/path"],
    ["https://products.example", "https://products.example"],
  ]) {
    assert.throws(() =>
      createPublicConsumerApi(() => Promise.resolve(apiResponse(200, {})), {
        accessToken: null,
        allowedOrigins,
      }),
    );
  }
});

await test("Lambda combines credential-only secrets with normal settings and rejects misplaced fields without leaking values", async () => {
  const secret = {
    http: { accessToken: "t".repeat(36) },
    rakuten: { applicationId: "example-app-1234", accessKey: "private-rakuten-key-123456" },
    commerce: { satofull: { token: "private-vc-token" } },
    accesstrade: { wsId: "private-at-wsid" },
    jev: { apiKey: "private-jev-key" },
  };
  const normal = {
    http: { allowedOrigin: "https://consumer.example" },
    rakuten: {
      affiliateId: "11111111.22222222.33333333.44444444",
      allowedOrigin: "https://consumer.example",
    },
    commerce: { satofull: { siteId: "1234567", spaceId: "123456789", aiAuthorized: false } },
    jev: { model: "jev-1.13.0" },
  };
  const configuration = combineLambdaConfiguration(secret, normal);
  const api = createLambdaApi(
    configuration,
    "arn:aws:lambda:ap-northeast-1:123456789012:function:worker",
    tables,
  );
  createLambdaWorker(configuration, tables);
  const response = await api({
    ...event,
    rawPath: "/api/commerce/sources",
    body: "",
    requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    response.body.includes('"id":"satofull","label":"さとふる","configured":true'),
    true,
  );
  for (const value of [
    secret.rakuten.accessKey,
    secret.commerce.satofull.token,
    secret.accesstrade.wsId,
    secret.jev.apiKey,
  ]) {
    assert.equal(response.body.includes(value), false);
  }
  for (const [credentials, settings] of [
    [{ ...secret, http: { ...secret.http, allowedOrigin: "https://wrong.example" } }, normal],
    [
      { ...secret, rakuten: { ...secret.rakuten, affiliateId: normal.rakuten.affiliateId } },
      normal,
    ],
    [
      { ...secret, commerce: { satofull: { ...secret.commerce.satofull, siteId: "1234567" } } },
      normal,
    ],
    [secret, { ...normal, jev: { ...normal.jev, apiKey: "private-key-in-wrong-place" } }],
    [
      secret,
      {
        ...normal,
        commerce: { satofull: { ...normal.commerce.satofull, token: "private-vc-in-wrong-place" } },
      },
    ],
  ]) {
    assert.throws(() => combineLambdaConfiguration(credentials, settings), {
      message: "Invalid Lambda configuration fields",
    });
  }
});

await test("securities public API works without provider keys and checks origin, body and shared admission", async () => {
  const clock = instant("2026-10-25T01:00:00.000Z");
  if (clock.tag !== "ok") {
    throw new Error("Invalid test clock");
  }
  const internal = createApiHandler(false, null, null, null, {
    clock: () => clock.value,
    allowedOrigin: "https://consumer.example",
  });
  const gateway = createPublicConsumerApi(internal, {
    accessToken: null,
    allowedOrigin: "https://consumer.example",
  });
  const headers = { origin: "https://consumer.example", "content-type": "application/json" };
  const initial = await gateway({ path: "/api/securities", method: "GET", headers }, "192.0.2.1");
  assert.equal(initial.statusCode, 200);
  const parsed: unknown = JSON.parse(initial.body);
  assert.ok(record(parsed) && record(parsed["value"]));
  assert.ok(Array.isArray(parsed["value"]["rows"]));
  assert.equal(parsed["value"]["rows"].length, 3);
  const body = JSON.stringify({
    mode: "stock",
    account: "taxable",
    tradeYen: 100_000,
    orders: 2,
    sbiElectronicDelivery: true,
    rakutenZeroCourse: true,
  });
  const event = { path: "/api/securities", method: "POST", headers, body };
  assert.equal((await gateway(event, "192.0.2.1")).statusCode, 200);
  assert.equal(
    (
      await gateway(
        { ...event, headers: { ...headers, origin: "https://other.example" } },
        "192.0.2.1",
      )
    ).statusCode,
    403,
  );
  assert.equal((await gateway({ ...event, body: "{}" }, "192.0.2.1")).statusCode, 400);
  assert.equal((await gateway({ ...event, body: "{" }, "192.0.2.1")).statusCode, 400);
  assert.equal((await gateway({ ...event, body: " ".repeat(4097) }, "192.0.2.1")).statusCode, 400);
  assert.equal((await gateway({ ...event, method: "OPTIONS" }, "192.0.2.1")).statusCode, 204);
  const denied = createPublicConsumerApi(internal, {
    accessToken: null,
    allowedOrigin: "https://consumer.example",
    consumeRateLimit: () => Promise.resolve(false),
  });
  assert.equal((await denied(event, "192.0.2.1")).statusCode, 429);
});

await test("securities approved ASP links are validated at bootstrap and expire to official links", async () => {
  const clock = instant("2026-10-25T01:00:00.000Z");
  if (clock.tag !== "ok") {
    throw new Error("Invalid test clock");
  }
  const link = {
    brokerId: "sbi",
    provider: "accesstrade",
    programId: "reviewed-program",
    url: "https://h.accesstrade.net/sp/cc?rk=reviewed",
    approvedUntil: "2026-10-26T00:00:00.000Z",
    creative: {
      text: "広告主指定の申込案内",
      impressionUrl: "https://h.accesstrade.net/sp/rr?rk=reviewed",
    },
  };
  const handler = createApiHandler(false, null, null, null, {
    clock: () => clock.value,
    securitiesAffiliateConfiguration: [link],
  });
  const response = await handler({ path: "/api/securities", method: "GET" });
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.includes("https://h.accesstrade.net/sp/cc?rk=reviewed"));
  assert.ok(response.body.includes("広告主指定の申込案内"));
  assert.ok(response.body.includes("https://h.accesstrade.net/sp/rr?rk=reviewed"));
  const urlOnly = {
    brokerId: link.brokerId,
    provider: link.provider,
    programId: link.programId,
    url: link.url,
    approvedUntil: link.approvedUntil,
  };
  const legacy = createApiHandler(false, null, null, null, {
    clock: () => clock.value,
    securitiesAffiliateConfiguration: [urlOnly],
  });
  assert.equal(
    (await legacy({ path: "/api/securities", method: "GET" })).body.includes("rk=reviewed"),
    false,
  );
  for (const input of [
    [{ ...link, url: "https://evil.example/sp/cc?rk=reviewed" }],
    [{ ...link, url: "http://h.accesstrade.net/sp/cc?rk=reviewed" }],
    [{ ...link, url: "https://user:pass@h.accesstrade.net/sp/cc?rk=reviewed" }],
    [{ ...link, approvedUntil: "tomorrow" }],
    [link, link],
    [{ ...link, brokerId: "unknown" }],
    [{ ...link, provider: "valuecommerce" }],
    [{ ...link, creative: { text: "<script>bad</script>", impressionUrl: null } }],
    [{ ...link, creative: { text: "申込", impressionUrl: "https://evil.example/pixel" } }],
    [
      {
        ...link,
        creative: { text: "申込", impressionUrl: "https://h.accesstrade.net/sp/rr?rk=another" },
      },
    ],
  ]) {
    assert.throws(() =>
      createApiHandler(false, null, null, null, { securitiesAffiliateConfiguration: input }),
    );
  }
});

await test("Lambda accepts optional AccessTrade WSID without exposing it and rejects malformed secret settings", async () => {
  const settings = {
    rakuten: null,
    openai: null,
    http: { accessToken: "t".repeat(36), allowedOrigin: "https://consumer.example" },
  };
  const workerArn = "arn:aws:lambda:ap-northeast-1:123456789012:function:worker";
  for (const accesstrade of [undefined, null, { wsId: "private-test-wsid" }]) {
    const configuration = { ...settings, accesstrade };
    const api = createLambdaApi(configuration, workerArn, tables);
    createLambdaWorker(configuration, tables);
    const response = await api({
      ...event,
      rawPath: "/api/commerce/sources",
      body: "",
      requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("private-test-wsid"), false);
  }
  for (const accesstrade of [
    "private-test-wsid",
    {},
    { wsId: "" },
    { wsId: "contains whitespace" },
    { wsId: "secret\nvalue" },
    { wsId: "x".repeat(513) },
    { wsId: 123 },
    { wsid: "wrong-field-name" },
    { wsId: "private-test-wsid", token: "unexpected" },
  ]) {
    const configuration = { ...settings, accesstrade };
    assert.throws(() => createLambdaApi(configuration, workerArn, tables), {
      message: "Invalid AccessTrade settings; expected wsId",
    });
    assert.throws(() => createLambdaWorker(configuration, tables), {
      message: "Invalid AccessTrade settings; expected wsId",
    });
  }
});

await test("Lambda bootstrap runs the catalog without Firebase and rejects public-shaped worker events", async () => {
  const settings = {
    rakuten: {
      applicationId: "example-app-1234",
      accessKey: "example-access-key-1234567890",
      affiliateId: "11111111.22222222.33333333.44444444",
      allowedOrigin: "https://consumer.example/",
      accessToken: "t".repeat(36),
    },
    openai: null,
    http: { accessToken: "t".repeat(36), allowedOrigin: "https://consumer.example" },
  };
  const api = createLambdaApi(
    settings,
    "arn:aws:lambda:ap-northeast-1:123456789012:function:worker",
    tables,
  );
  const catalog = await api({
    ...event,
    rawPath: "/api/catalog",
    body: "",
    requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  const worker = createLambdaWorker(settings, tables);
  await assert.rejects(worker({ ...event, jobId: "a".repeat(64) }), /Invalid worker event/);
  assert.throws(() =>
    createLambdaApi(
      { ...settings, http: { ...settings.http, allowedOrigin: "http://consumer.example" } },
      "invalid",
      tables,
    ),
  );
});

await test("HTTP API adapter validates gateway envelope and uses its trusted source address", async () => {
  let seenAddress = "";
  let seenBody: unknown;
  const handler = createLambdaHttpHandler(async (request, address) => {
    seenAddress = address;
    seenBody = request;
    await Promise.resolve();
    return apiResponse(200, "accepted");
  });
  assert.equal(
    (
      await handler({
        ...event,
        isBase64Encoded: true,
        body: Buffer.from(event.body).toString("base64"),
      })
    ).statusCode,
    200,
  );
  assert.equal(seenAddress, "192.0.2.1");
  assert.deepEqual(seenBody, {
    path: event.rawPath,
    method: "POST",
    query: "",
    headers: event.headers,
    body: event.body,
  });
  for (const invalid of [
    null,
    { jobId: "a".repeat(64) },
    { ...event, version: "1.0" },
    { ...event, rawPath: "/api/%2e%2e/private" },
    { ...event, rawPath: "/private" },
    { ...event, requestContext: { http: { method: "POST", sourceIp: "spoofed" } } },
  ]) {
    assert.equal((await handler(invalid)).statusCode, 400);
  }
  assert.equal((await handler({ ...event, isBase64Encoded: true, body: "%%%" })).statusCode, 413);
  assert.equal((await handler({ ...event, body: "あ".repeat(2048) })).statusCode, 413);
});

await test("Lambda result reads reject bursts before storage and reset without limiting legitimate polling", async () => {
  let now = 60_000;
  let forwarded = 0;
  const origin = "https://consumer.example";
  const handler = createLambdaHttpHandler(
    async () => {
      forwarded += 1;
      await Promise.resolve();
      return apiResponse(200, "accepted");
    },
    { clock: () => now, allowedOrigin: origin },
  );
  const read = {
    ...event,
    rawPath: `/api/comparisons/${"a".repeat(64)}`,
    body: "",
    requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
  };
  for (let index = 0; index < 240; index += 1) {
    assert.equal((await handler(read)).statusCode, 200);
  }
  const denied = await handler({ ...read, headers: { origin: "https://attacker.invalid" } });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers["access-control-allow-origin"], origin);
  assert.equal(denied.headers["retry-after"], "60");
  assert.equal(forwarded, 240);
  // A valid job ID or comparison key is not trusted for pre-storage admission.
  assert.equal(
    (
      await handler({
        ...read,
        rawPath: `/api/comparisons/${"b".repeat(64)}`,
        headers: { "x-comparison-key": "k".repeat(36) },
      })
    ).statusCode,
    429,
  );
  assert.equal((await handler(event)).statusCode, 200);
  now += 60_000;
  assert.equal((await handler(read)).statusCode, 200);
  // Rotating addresses is still bounded by a global in-memory budget.
  for (let index = 0; index < 1199; index += 1) {
    assert.equal(
      (
        await handler({
          ...read,
          requestContext: {
            http: { method: "GET", sourceIp: `2001:db8::${(index + 2).toString(16)}` },
          },
        })
      ).statusCode,
      200,
    );
  }
  const before = forwarded;
  assert.equal(
    (await handler({ ...read, requestContext: { http: { method: "GET", sourceIp: "192.0.2.2" } } }))
      .statusCode,
    429,
  );
  assert.equal(forwarded, before);
});

await test("Lambda dispatch sends only job identity, requires AWS acceptance and rejects arbitrary destinations", async () => {
  const arn = "arn:aws:lambda:ap-northeast-1:123456789012:function:compare-worker";
  const id = "a".repeat(64);
  const dispatch = createLambdaDispatcher(arn, async (command, signal) => {
    assert.equal(command.input.FunctionName, arn);
    assert.equal(command.input.InvocationType, "Event");
    assert.ok(command.input.Payload instanceof Uint8Array);
    const payload: unknown = JSON.parse(new TextDecoder().decode(command.input.Payload));
    assert.deepEqual(payload, { jobId: id });
    assert.equal(signal.aborted, false);
    await Promise.resolve();
    return { StatusCode: 202 };
  });
  await dispatch(id);
  await assert.rejects(dispatch("invalid"));
  assert.throws(() => createLambdaDispatcher("https://attacker.example"));
  const failed = createLambdaDispatcher(arn, () => Promise.resolve({ StatusCode: 200 }));
  await assert.rejects(failed(id));
});

await test("failed dispatch is retried with the same operation without creating another comparison", async () => {
  const time = instant("2026-10-21T12:00:00.000Z");
  assert.equal(time.tag, "ok");
  const clock = () => time.value;
  const store = createMemoryComparisonJobStore(clock);
  let attempts = 0;
  const token = "server-token-123456789012345678901234567890";
  const internal = createApiHandler(false, null, null, null, {
    apiAccessToken: token,
    redispatchQueued: true,
    jobStore: store,
    clock,
    consumerService: createConsumerComparisonService([], undefined, clock),
    dispatchComparisonJob: async () => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) {
        throw new Error("private AWS credentials");
      }
    },
  });
  const gateway = createPublicConsumerApi(internal, {
    accessToken: token,
    allowedOrigin: "https://consumer.example",
  });
  const request = {
    path: "/api/comparisons",
    method: "POST",
    headers: { origin: "https://consumer.example", "x-comparison-key": "k".repeat(36) },
    body: JSON.stringify({
      url: "https://synthetic.example/source",
      keyword: null,
      category: "laptop",
      conditions: {},
      sort: "price",
      idempotencyKey: "operation",
    }),
  };
  const failed = await gateway(request, "192.0.2.1");
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.body.includes("credentials"), false);
  const retry = await gateway(request, "192.0.2.1");
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(attempts, 2);
});

await test("shared rate limiter denies excessive requests and fails closed on storage loss", async () => {
  const settings = { accessToken: "t".repeat(36), allowedOrigin: "https://consumer.example" };
  const request = {
    path: "/api/detect",
    method: "POST",
    headers: { origin: settings.allowedOrigin },
    body: event.body,
  };
  const internal = async () => {
    await Promise.resolve();
    return apiResponse(200, "accepted");
  };
  const denied = createPublicConsumerApi(internal, {
    ...settings,
    consumeRateLimit: () => Promise.resolve(false),
  });
  assert.equal((await denied(request, "192.0.2.1")).statusCode, 429);
  const unavailable = createPublicConsumerApi(internal, {
    ...settings,
    consumeRateLimit: async () => {
      await Promise.resolve();
      throw new Error("private db password");
    },
  });
  const failure = await unavailable(request, "192.0.2.1");
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.body.includes("password"), false);
});

await test("Function URL preserves synchronous responses past thirty seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const handler = createLambdaHttpHandler(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 31_000));
    return apiResponse(200, { tag: "ok", value: "fresh response" });
  });
  const pending = handler(event);
  context.mock.timers.tick(31_000);
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
});

await test("Lambda capability cancellation retains CORS, server auth and shared limits", async () => {
  const token = "t".repeat(36);
  const allowedOrigin = "https://consumer.example";
  const requests: unknown[] = [];
  let limited = 0;
  const gateway = createPublicConsumerApi(
    async (request) => {
      requests.push(request);
      await Promise.resolve();
      return apiResponse(200, "accepted");
    },
    {
      accessToken: token,
      allowedOrigin,
      allowCapabilityCancellation: true,
      consumeRateLimit: async () => {
        limited += 1;
        await Promise.resolve();
        return true;
      },
    },
  );
  const paths = [`/api/comparisons/${"a".repeat(64)}/cancel`];
  for (const path of paths) {
    const headers = {
      origin: allowedOrigin,
      "content-type": "application/json",
      "x-comparison-key": "k".repeat(36),
    };
    const preflight = await gateway({ path, method: "OPTIONS", headers }, "192.0.2.1");
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], allowedOrigin);
    const body = path.endsWith("/cancel")
      ? "{}"
      : JSON.stringify({
          url: "https://item.rakuten.co.jp/shop/product/",
          category: "laptop",
          conditions: {},
          sort: "price",
        });
    const response = await gateway({ path, method: "POST", headers, body }, "192.0.2.1");
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
    assert.deepEqual(requests.at(-1), {
      path,
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body,
    });
  }
  assert.equal(limited, 1);
});

await test("Lambda public cancellation still requires the matching per-job capability", async () => {
  const time = instant("2026-10-21T12:00:00.000Z");
  assert.equal(time.tag, "ok");
  const clock = () => time.value;
  const store = createMemoryComparisonJobStore(clock);
  const token = "t".repeat(36);
  const allowedOrigin = "https://consumer.example";
  const internal = createApiHandler(false, null, null, null, {
    apiAccessToken: token,
    jobStore: store,
    clock,
    consumerService: createConsumerComparisonService([], undefined, clock),
    dispatchComparisonJob: () => Promise.resolve(),
  });
  const gateway = createPublicConsumerApi(internal, {
    accessToken: token,
    allowedOrigin,
    allowCapabilityCancellation: true,
  });
  const accessKey = "k".repeat(36);
  const headers = {
    origin: allowedOrigin,
    "content-type": "application/json",
    "x-comparison-key": accessKey,
  };
  const accepted = await gateway(
    {
      path: "/api/comparisons",
      method: "POST",
      headers,
      body: JSON.stringify({
        url: "https://synthetic.example/source",
        keyword: null,
        category: "laptop",
        conditions: {},
        sort: "price",
        idempotencyKey: "cancel-operation",
      }),
    },
    "192.0.2.1",
  );
  assert.equal(accepted.statusCode, 202, accepted.body);
  const decoded: unknown = JSON.parse(accepted.body);
  assert.ok(
    record(decoded) && record(decoded["value"]) && typeof decoded["value"]["id"] === "string",
  );
  const path = `/api/comparisons/${decoded["value"]["id"]}/cancel`;
  for (const key of [null, "wrong-key-123456789012345678901234567890"]) {
    const response = await gateway(
      {
        path,
        method: "POST",
        headers: {
          origin: allowedOrigin,
          "content-type": "application/json",
          ...(key === null ? {} : { "x-comparison-key": key }),
        },
        body: "{}",
      },
      "192.0.2.1",
    );
    assert.equal(response.statusCode, 403, response.body);
  }
  const cancelled = await gateway({ path, method: "POST", headers, body: "{}" }, "192.0.2.1");
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.body.includes('"state":"cancelled"'), true);
});
