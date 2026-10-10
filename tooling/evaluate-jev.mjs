import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { parseScoreAnswer } from "../packages/backend/dist/comparison/ranking.js";
import { createJevJudge } from "../packages/backend/dist/providers/jev/index.js";

const replay = process.argv[2] === "--replay";
if (!replay && existsSync(".env")) {
  process.loadEnvFile(".env");
}
const apiKey = process.env["TYPESAFE_API_KEY"] ?? "";
assert.ok(replay || apiKey.length > 0, "TYPESAFE_API_KEY is required for live evaluation");
const positional = process.argv.slice(replay ? 3 : 2);
const inputPath = positional[0] ?? "docs/jev-evaluation-cases.json";
const outputPath =
  positional[1] ??
  (replay ? "docs/jev-evaluation-replay.json" : "docs/jev-evaluation-results.json");
assert.ok(inputPath !== outputPath, "Keep the pre-labelled inputs separate from results");
const source = readFileSync(inputPath, "utf8");
const input = JSON.parse(source);
assert.equal(input.model, "jev-1.13.0");
assert.ok(Array.isArray(input.cases) && input.cases.length > 0 && input.cases.length <= 50);
assert.ok(Array.isArray(input.repeats) && input.repeats.length <= 10);
assert.ok(input.questions !== null && typeof input.questions === "object");
const category = input.category ?? "usb-c-wall-charger";
assert.ok(typeof category === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(category));
const ids = Object.keys(input.questions);
for (const item of input.cases) {
  assert.ok(typeof item.id === "string" && typeof item.preferences === "string");
  assert.ok(item.facts !== null && typeof item.facts === "object");
  for (const id of ids) {
    assert.ok([0, 1, 2, "abstain"].includes(item.expected[id]));
  }
}
if (replay) {
  const baseline = JSON.parse(
    readFileSync(positional[2] ?? "docs/jev-evaluation-results.json", "utf8"),
  );
  assert.equal(baseline.inputSha256, createHash("sha256").update(source).digest("hex"));
  assert.ok(Array.isArray(baseline.rows));
  const rows = baseline.rows.map((row) => {
    const item = input.cases.find((entry) => entry.id === row.id);
    assert.ok(item !== undefined);
    const axes = Object.fromEntries(
      ids.map((id) => {
        const parsed = parseScoreAnswer(row.transport?.answers?.[id], input.questions[id].criteria);
        const decision =
          parsed.tag === "err" || row.transport?.model !== input.model
            ? "invalid_response"
            : parsed.value.confidence < input.minimumConfidence
              ? "abstain"
              : Math.round(parsed.value.score);
        return [
          id,
          {
            validation: parsed.tag,
            expected: item.expected[id],
            decision,
            agrees: decision === item.expected[id],
            ...(parsed.tag === "ok"
              ? { score: parsed.value.score, confidence: parsed.value.confidence }
              : {}),
          },
        ];
      }),
    );
    return {
      id: row.id,
      group: item.group,
      repeat: row.repeat,
      originalValidation: row.result.tag,
      axes,
      candidateDecision: Object.values(axes).some((axis) => typeof axis.decision !== "number")
        ? "withheld"
        : "scored",
    };
  });
  const document = {
    replayedAt: new Date().toISOString(),
    inputSha256: baseline.inputSha256,
    note: "Offline revalidation of the same live responses; no API calls and no relabeling",
    rows,
  };
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    JSON.stringify({
      replayed: rows.length,
      valid: rows.filter((row) => Object.values(row.axes).every((axis) => axis.validation === "ok"))
        .length,
    }),
  );
} else {
  const startedAt = new Date().toISOString();
  const rows = [];
  let latestTransport;
  const judge = createJevJudge(apiKey, input.model, async (url, options) => {
    const response = await globalThis.fetch(url, options);
    latestTransport = { status: response.status };
    if (response.ok) {
      const body = await response.clone().json();
      // Never write request headers, credentials or upstream error bodies.
      latestTransport = {
        status: response.status,
        model: body.model,
        answers: body.answers,
        usage: body.usage,
      };
    }
    return response;
  });
  const schedule = [
    ...input.cases.map((item) => ({ item, repeat: 0 })),
    ...input.repeats.flatMap((id) => {
      const item = input.cases.find((entry) => entry.id === id);
      assert.ok(item !== undefined);
      return [1, 2, 3, 4].map((repeat) => ({ item, repeat }));
    }),
  ];
  assert.ok(schedule.length <= 90, "Bound live API spending");
  for (const [index, { item, repeat }] of schedule.entries()) {
    latestTransport = null;
    const start = performance.now();
    const result = await judge({
      state: {
        category,
        mode: "overall",
        preferences: item.preferences,
        facts: item.facts,
        excerpts: {},
      },
      questions: input.questions,
    });
    rows.push({
      id: item.id,
      group: item.group,
      repeat,
      expected: item.expected,
      rubricExpected: item.rubricExpected ?? item.expected,
      durationMs: Math.round(performance.now() - start),
      transport: latestTransport,
      result,
    });
    const document = {
      startedAt,
      updatedAt: new Date().toISOString(),
      model: input.model,
      category,
      inputSha256: createHash("sha256").update(source).digest("hex"),
      minimumConfidence: input.minimumConfidence,
      labelAuthor:
        "Codex; labels fixed before live requests; synthetic pilot, no independent human validation",
      rows,
    };
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
    if (
      result.tag === "err" &&
      ["unauthorized", "payment_required", "unavailable"].includes(result.error)
    ) {
      console.log(
        JSON.stringify({
          completed: rows.length,
          total: schedule.length,
          stopped: result.error,
          status: latestTransport?.status ?? null,
        }),
      );
      process.exitCode = 1;
      break;
    }
    if (index === 0 || (index + 1) % 5 === 0 || index === schedule.length - 1) {
      console.log(
        JSON.stringify({
          completed: rows.length,
          total: schedule.length,
          lastId: item.id,
          response: result.tag,
          status: latestTransport?.status ?? null,
        }),
      );
    }
  }
}
