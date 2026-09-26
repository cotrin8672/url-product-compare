import assert from "node:assert/strict";
import { test } from "node:test";

import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { productsSchema, readProduct } from "../../comparison/catalog.js";
import { factSchema, rankProducts } from "../../comparison/ranking.js";
import type { Candidate, Judge, RankingPolicy } from "../../comparison/ranking.js";
import { instant, valueOf } from "../../comparison/values.js";

function unwrap<T, E>(result: Result<T, E>): T {
  assert.equal(result.tag, "ok");
  return result.value;
}

const observedAt = "2026-09-26T00:00:00.000Z";
const expiresAt = "2026-09-27T00:00:00.000Z";
const now = unwrap(instant("2026-09-26T01:00:00.000Z"));
const rights = Object.freeze({
  fetch: { status: "granted", expiresAt },
  display: { status: "granted", expiresAt },
  store: { status: "denied" },
  ai: { status: "granted", expiresAt },
  affiliate: { status: "denied" },
});
const policy = {
  version: "charger-demo-v1",
  category: "usb-c-wall-charger",
  mode: "overall",
  tieMargin: 0.06,
  minimumConfidence: 0.7,
  criteria: [
    {
      id: "device_fit",
      weight: 3,
      factKeys: ["powerW"],
      instructions:
        "Rate how well the verified maximum USB-C PD output meets the user's stated device power need. Do not infer sustained performance.",
      levels: [
        "Cannot meet need",
        "Far below need",
        "Partly meets need",
        "Meets need",
        "Meets need with useful headroom",
      ],
    },
    {
      id: "port_fit",
      weight: 1,
      factKeys: ["usbCPorts"],
      instructions:
        "Rate how well the verified USB-C port count meets the user's stated simultaneous charging need.",
      levels: [
        "Cannot meet need",
        "Far below need",
        "Partly meets need",
        "Meets need",
        "Exceeds need usefully",
      ],
    },
  ],
} as const satisfies RankingPolicy;

function candidate(
  id: string,
  powerW: number,
  usbCPorts = 2,
  inputRights: unknown = rights,
): Candidate {
  const evidence = { provider: "example", source: `https://example.com/${id}`, observedAt };
  const product = unwrap(
    productsSchema.parse([
      {
        productId: id,
        evidence,
        permissions: inputRights,
        identity: {
          manufacturer: "Example",
          model: id,
          gtin: null,
          variant: { status: "confirmed", color: null, capacity: null, packCount: 1 },
        },
      },
    ]),
  )[0];
  if (product === undefined) {
    throw new Error("Expected a parsed product");
  }
  return Object.freeze({
    product,
    facts: Object.freeze([
      unwrap(
        factSchema.parse({
          productId: id,
          key: "powerW",
          value: powerW,
          evidence,
          permissions: inputRights,
        }),
      ),
      unwrap(
        factSchema.parse({
          productId: id,
          key: "usbCPorts",
          value: usbCPorts,
          evidence,
          permissions: inputRights,
        }),
      ),
    ]),
  });
}

const judge: Judge = ({ state, questions }) => {
  assert.deepEqual(Object.keys(questions), ["device_fit", "port_fit"]);
  const power = state.facts["powerW"];
  const score = power === 100 ? 4 : power === 95 ? 3.8 : 2;
  return Promise.resolve(
    ok({
      model: "jev-test",
      answers: { device_fit: { score, confidence: 0.9 }, port_fit: { score, confidence: 0.9 } },
    }),
  );
};

await test("independent criterion scoring ranks A and rivals, ties close scores, and ignores input order", async () => {
  const a = candidate("a", 100);
  const b = candidate("b", 95);
  const c = candidate("c", 65);
  const run = async (input: readonly Candidate[]) =>
    unwrap(
      await rankProducts(
        input,
        [{ key: "usbCPorts", comparison: "at_least", value: 2 }],
        "Two USB-C ports and at least 65 W",
        policy,
        judge,
        now,
      ),
    );
  const first = await run([c, a, b]);
  const second = await run([b, c, a]);
  const ids = (ranking: typeof first): readonly string[] =>
    ranking.ranked.map((entry) => valueOf(readProduct(entry.product).id));
  assert.deepEqual(ids(first), ["a", "b", "c"]);
  assert.deepEqual(ids(second), ids(first));
  assert.deepEqual(
    first.ranked.map((entry) => entry.rank),
    [1, 1, 3],
  );
  assert.equal(first.displayPercent, false);
  const source = first.ranked[0]?.criteria[0]?.evidence[0]?.source;
  assert.equal(source === undefined ? undefined : valueOf(source), "https://example.com/a");
});

await test("hard constraints exclude known mismatches before Jev; missing evidence and AI rights abstain", async () => {
  const a = candidate("a", 100);
  const b = candidate("b", 95, 1);
  let calls = 0;
  const counting: Judge = async (request) => {
    calls += 1;
    return await judge(request);
  };
  const result = unwrap(
    await rankProducts(
      [a, b],
      [{ key: "usbCPorts", comparison: "at_least", value: 2 }],
      "Two ports",
      policy,
      counting,
      now,
    ),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.excluded.map((product) => valueOf(readProduct(product).id)),
    ["b"],
  );
  const missing = await rankProducts(
    [{ ...a, facts: a.facts.filter((fact) => fact.key === "powerW") }],
    [],
    "Two ports",
    policy,
    counting,
    now,
  );
  assert.deepEqual(missing, err({ code: "insufficient_evidence" }));
  assert.equal(calls, 1);
  const denied = candidate("denied", 100, 2, { ...rights, ai: { status: "denied" } });
  assert.deepEqual(
    await rankProducts([denied], [], "Two ports", policy, counting, now),
    err({ code: "ai_not_authorized" }),
  );
  assert.equal(calls, 1);
});

await test("Jev failure, weak confidence and malformed output never create rankings", async () => {
  const a = candidate("a", 100);
  assert.deepEqual(
    await rankProducts(
      [a],
      [],
      "Two ports",
      policy,
      () => Promise.resolve(err("unavailable")),
      now,
    ),
    err({ code: "jev_unavailable" }),
  );
  assert.deepEqual(
    await rankProducts(
      [a],
      [],
      "Two ports",
      policy,
      () => Promise.resolve(err("payment_required")),
      now,
    ),
    err({ code: "jev_payment_required" }),
  );
  assert.deepEqual(
    await rankProducts(
      [a],
      [],
      "Two ports",
      policy,
      () =>
        Promise.resolve(
          ok({
            model: "jev-test",
            answers: {
              device_fit: { score: 4, confidence: 0.1 },
              port_fit: { score: 4, confidence: 0.9 },
            },
          }),
        ),
      now,
    ),
    err({ code: "assessment_uncertain" }),
  );
  assert.deepEqual(
    await rankProducts(
      [a],
      [],
      "Two ports",
      policy,
      () =>
        Promise.resolve(
          ok({
            model: "jev-test",
            answers: {
              device_fit: { score: Number.NaN, confidence: 0.9 },
              port_fit: { score: 4, confidence: 0.9 },
            },
          }),
        ),
      now,
    ),
    err({ code: "invalid_jev_response" }),
  );
});
