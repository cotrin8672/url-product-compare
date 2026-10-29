import { readBoundedResponseText } from "./response.js";

type ErrorCode =
  | "unavailable"
  | "invalid_request"
  | "invalid_response"
  | "payment_required"
  | "unauthorized"
  | "rate_limited";
type EvaluationResult =
  | Readonly<{
      tag: "ok";
      value: Readonly<{ model: string; answers: Readonly<Record<string, unknown>> }>;
    }>
  | Readonly<{ tag: "err"; error: ErrorCode }>;
type Configuration = Readonly<{ apiKey: string; model: string }>;
type Request = Readonly<{ state: unknown; questions: Readonly<Record<string, unknown>> }>;
type Client = Readonly<{
  evaluate: (
    input: Request,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ) => Promise<EvaluationResult>;
}>;
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function failure(error: ErrorCode): EvaluationResult {
  return Object.freeze({ tag: "err", error });
}

function validJson(input: unknown, depth: number, ancestors: Set<object>): boolean {
  if (depth > 64) {
    return false;
  }
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return true;
  }
  if (typeof input === "number") {
    return Number.isFinite(input);
  }
  if (typeof input !== "object" || ancestors.has(input)) {
    return false;
  }
  ancestors.add(input);
  const valid = Object.values(input).every((entry: unknown) =>
    validJson(entry, depth + 1, ancestors),
  );
  ancestors.delete(input);
  return valid;
}
function validQuestions(input: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(input);
  return (
    entries.length > 0 &&
    entries.length <= 512 &&
    entries.every(([id, question]) => {
      if (
        id.trim().length === 0 ||
        id.length > 128 ||
        !record(question) ||
        (typeof question["instructions"] !== "string" &&
          !Array.isArray(question["instructions"]) &&
          !record(question["instructions"]))
      ) {
        return false;
      }
      const criteria = question["criteria"];
      if (question["type"] === "choice") {
        return (
          record(criteria) &&
          Object.keys(criteria).length >= 1 &&
          Object.keys(criteria).length <= 255
        );
      }
      if (question["type"] === "score") {
        return Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10;
      }
      return question["type"] === "noul" && (criteria === undefined || record(criteria));
    })
  );
}

/** Only the TypeSafe HTTP protocol: callers own prompts, rubrics, confidence policy and interpretation. */
export function createJevClient(
  configuration: Configuration,
  fetcher: typeof fetch = fetch,
): Client {
  if (
    configuration.apiKey.trim().length === 0 ||
    configuration.apiKey.length > 512 ||
    /[\r\n]/u.test(configuration.apiKey) ||
    !/^jev-\d+\.\d+\.\d+$/u.test(configuration.model)
  ) {
    throw new Error("Invalid Jev API credentials");
  }
  return Object.freeze({
    async evaluate(input, options = {}) {
      options.signal?.throwIfAborted();
      const timeout = options.timeoutMs ?? 8000;
      let encoded: string;
      try {
        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > 60000 ||
          (typeof input.state !== "string" &&
            !Array.isArray(input.state) &&
            !record(input.state)) ||
          !validQuestions(input.questions) ||
          !validJson(input.state, 0, new Set()) ||
          !validJson(input.questions, 0, new Set())
        ) {
          return failure("invalid_request");
        }
        encoded = JSON.stringify({
          model: configuration.model,
          state: input.state,
          questions: input.questions,
        });
        if (new TextEncoder().encode(encoded).length > 33_554_432) {
          return failure("invalid_request");
        }
      } catch {
        return failure("invalid_request");
      }
      const deadline = AbortSignal.timeout(timeout);
      const signal =
        options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
      try {
        const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            "Content-Type": "application/json",
          },
          body: encoded,
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return failure(
            response.status === 402
              ? "payment_required"
              : response.status === 401 || response.status === 403
                ? "unauthorized"
                : response.status === 429
                  ? "rate_limited"
                  : "unavailable",
          );
        }
        const raw = await readBoundedResponseText(response, 262144, signal);
        options.signal?.throwIfAborted();
        if (raw === null) {
          return failure("invalid_response");
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return failure("invalid_response");
        }
        const answers = record(body) ? body["answers"] : undefined;
        if (
          !record(body) ||
          body["model"] !== configuration.model ||
          !record(answers) ||
          Object.keys(answers).length !== Object.keys(input.questions).length ||
          Object.keys(input.questions).some((id) => !Object.hasOwn(answers, id))
        ) {
          return failure("invalid_response");
        }
        return Object.freeze({
          tag: "ok",
          value: Object.freeze({
            model: configuration.model,
            answers: Object.freeze({ ...answers }),
          }),
        });
      } catch {
        options.signal?.throwIfAborted();
        return failure("unavailable");
      }
    },
  });
}
