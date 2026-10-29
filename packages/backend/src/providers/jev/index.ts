import { createJevClient } from "@app/jev-api";

import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { parseScoreAnswer } from "../../comparison/ranking.js";
import type { Judge, JudgeRequest, JudgeResponse } from "../../comparison/ranking.js";
import { record } from "../../comparison/values.js";

function parseResponse(
  input: unknown,
  request: JudgeRequest,
  model: string,
): Result<JudgeResponse, "invalid_response"> {
  if (!record(input) || input["model"] !== model || !record(input["answers"])) {
    return err("invalid_response");
  }
  const answers = input["answers"];
  const names = Object.keys(request.questions);
  if (Object.keys(answers).length !== names.length) {
    return err("invalid_response");
  }
  const parsed: Record<string, JudgeResponse["answers"][string]> = {};
  for (const name of names) {
    const answer = answers[name];
    const question = request.questions[name];
    if (!record(answer) || answer["type"] !== "score" || question === undefined) {
      return err("invalid_response");
    }
    const result = parseScoreAnswer(answer, question.criteria);
    if (result.tag === "err") {
      return result;
    }
    Object.defineProperty(parsed, name, { value: result.value, enumerable: true });
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
    if (apiKey.trim().length === 0 || !/^jev-\d+\.\d+\.\d+$/.test(model)) {
      return err("unavailable");
    }
    try {
      const result = await createJevClient({ apiKey, model }, fetcher).evaluate(request, {
        timeoutMs: 10000,
      });
      if (result.tag === "err") {
        return err(
          result.error === "invalid_request" || result.error === "rate_limited"
            ? "unavailable"
            : result.error,
        );
      }
      return parseResponse(result.value, request, model);
    } catch {
      return err("unavailable");
    }
  };
}
