import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import type { Judge, JudgeRequest, JudgeResponse } from "../../comparison/ranking.js";
import { record } from "../../comparison/values.js";

function parseResponse(
  input: unknown,
  request: JudgeRequest,
): Result<JudgeResponse, "invalid_response"> {
  if (!record(input) || typeof input["model"] !== "string" || !record(input["answers"])) {
    return err("invalid_response");
  }
  const answers = input["answers"];
  const names = Object.keys(request.questions);
  if (Object.keys(answers).length !== names.length) {
    return err("invalid_response");
  }
  const parsed: Record<string, Readonly<{ score: number; confidence: number }>> = {};
  for (const name of names) {
    const answer = answers[name];
    if (
      !record(answer) ||
      answer["type"] !== "score" ||
      typeof answer["score"] !== "number" ||
      !Number.isFinite(answer["score"]) ||
      answer["score"] < 0 ||
      answer["score"] > 4 ||
      typeof answer["confidence"] !== "number" ||
      !Number.isFinite(answer["confidence"]) ||
      answer["confidence"] < 0 ||
      answer["confidence"] > 1
    ) {
      return err("invalid_response");
    }
    parsed[name] = Object.freeze({ score: answer["score"], confidence: answer["confidence"] });
  }
  return ok(Object.freeze({ model: input["model"], answers: Object.freeze(parsed) }));
}

export function createJevJudge(
  apiKey: string,
  model: string,
  fetcher: typeof fetch = fetch,
): Judge {
  return async (
    request,
  ): Promise<
    Result<JudgeResponse, "unavailable" | "invalid_response" | "payment_required" | "unauthorized">
  > => {
    if (apiKey.trim().length === 0 || model.trim().length === 0) {
      return err("unavailable");
    }
    try {
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state: request.state, questions: request.questions }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 402) {
        return err("payment_required");
      }
      if (response.status === 401 || response.status === 403) {
        return err("unauthorized");
      }
      if (!response.ok) {
        return err("unavailable");
      }
      const body: unknown = await response.json();
      return parseResponse(body, request);
    } catch {
      return err("unavailable");
    }
  };
}
