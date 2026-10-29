import assert from "node:assert/strict";
import { test } from "node:test";

import { createJevClient } from "./index.js";

const configuration = { apiKey: "test-jev-key", model: "jev-1.13.0" };
const questions = {
  kind: {
    type: "choice",
    instructions: { task: "Select an option" },
    criteria: { a: "Option A", b: "Option B" },
  },
  grade: { type: "score", instructions: "Rate this fact", criteria: ["low", "high"] },
  relevant: { type: "noul", instructions: "Is it relevant?" },
};

await test("Jev standalone client sends structured Choice, Score and Noul without application prompts or model changes", async () => {
  const answers = {
    kind: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.95, b: 0.05 } },
    grade: {
      type: "score",
      score: 1,
      confidence: 1,
      legend: { "0": "low", "1": "high" },
      probabilities: { "0": 0, "1": 1 },
    },
    relevant: { type: "noul", noul: 0.9 },
  };
  const result = await createJevClient(configuration, (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-jev-key");
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    assert.equal(
      init.body,
      JSON.stringify({ model: configuration.model, state: { fact: "example" }, questions }),
    );
    return Promise.resolve(Response.json({ model: configuration.model, answers }));
  }).evaluate({ state: { fact: "example" }, questions });
  assert.equal(result.tag, "ok");
  assert.deepEqual(result.value.answers, answers);
});

await test("Jev rejects malformed or non-JSON inputs before a paid request", async () => {
  let calls = 0;
  const client = createJevClient(configuration, () => {
    calls += 1;
    return Promise.reject(new Error("Must not call"));
  });
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  for (const request of [
    { state: null, questions },
    { state: { x: Number.NaN }, questions },
    { state: cycle, questions },
    { state: {}, questions: {} },
    { state: {}, questions: { q: { type: "text", instructions: "Generate text" } } },
    {
      state: {},
      questions: { q: { type: "score", instructions: "Grade", criteria: ["only one"] } },
    },
  ]) {
    assert.equal((await client.evaluate(request)).tag, "err");
  }
  assert.equal((await client.evaluate({ state: {}, questions }, { timeoutMs: 0 })).tag, "err");
  assert.equal(calls, 0);
  assert.throws(() => createJevClient({ ...configuration, model: "unknown-model" }));
});

await test("Jev validates the answer envelope and distinguishes payment, authorization and rate errors", async () => {
  for (const body of [
    { model: "jev-1.12.0", answers: {} },
    { model: configuration.model, answers: { unexpected: {} } },
    { model: configuration.model, answers: { ...questions, extra: {} } },
  ]) {
    const result = await createJevClient(configuration, () =>
      Promise.resolve(Response.json(body)),
    ).evaluate({ state: {}, questions });
    assert.equal(result.tag, "err");
    assert.equal(result.error, "invalid_response");
  }
  for (const status of [401, 402, 403, 429, 500]) {
    const result = await createJevClient(configuration, () =>
      Promise.resolve(new Response("private-token", { status })),
    ).evaluate({ state: {}, questions });
    assert.equal(result.tag, "err");
    assert.equal(
      result.error,
      status === 402
        ? "payment_required"
        : status === 401 || status === 403
          ? "unauthorized"
          : status === 429
            ? "rate_limited"
            : "unavailable",
    );
    assert.equal(JSON.stringify(result).includes("private-token"), false);
  }
});

await test("Jev bounds streaming bytes, preserves split UTF-8 and propagates cancellation", async () => {
  let cancelled = false;
  const overflow = await createJevClient(configuration, () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(262145));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    ),
  ).evaluate({ state: {}, questions });
  assert.equal(overflow.tag, "err");
  assert.equal(overflow.error, "invalid_response");
  assert.equal(cancelled, true);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      model: configuration.model,
      answers: { q: { type: "noul", noul: 0.9, note: "日本語" } },
    }),
  );
  const valid = await createJevClient(configuration, () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) {
              controller.enqueue(new Uint8Array([byte]));
            }
            controller.close();
          },
        }),
      ),
    ),
  ).evaluate({ state: {}, questions: { q: questions.relevant } });
  assert.equal(valid.tag, "ok");
  const controller = new AbortController();
  let enter: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let released = false;
  const pending = createJevClient(configuration, () => {
    enter?.();
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            released = true;
          },
        }),
      ),
    );
  }).evaluate({ state: {}, questions }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered;
  controller.abort();
  await rejected;
  assert.equal(released, true);
});
