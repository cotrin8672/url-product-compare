type ApiError = Readonly<{
  code:
    | "invalid_request"
    | "provider_unavailable"
    | "provider_unauthorized"
    | "provider_rate_limited"
    | "invalid_response"
    | "listing_not_found";
}>;
export type ApiResult<T> =
  | Readonly<{ tag: "ok"; value: T }>
  | Readonly<{ tag: "err"; error: ApiError }>;
export function failure(code: ApiError["code"]): ApiResult<never> {
  return { tag: "err", error: { code } };
}
export function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
export function text(input: unknown, maximum = 2048): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= maximum &&
    !/\p{Cc}/u.test(input)
  );
}
export function natural(input: unknown): number | null {
  const value = typeof input === "string" && /^\d+(?:\.0+)?$/u.test(input) ? Number(input) : input;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function safeUrl(input: unknown, hosts?: readonly string[]): URL | null {
  if (!text(input, 4096)) {
    return null;
  }
  try {
    const url = new URL(input);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      (hosts === undefined || hosts.includes(url.hostname)) &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/iu.test(url.hostname) &&
      !/\.(?:localhost|local|internal|test|invalid|example)$/iu.test(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}
async function requestText(
  fetcher: typeof fetch,
  url: URL,
  options: RequestInit,
  parent?: AbortSignal,
): Promise<ApiResult<string>> {
  const deadline = AbortSignal.timeout(8000);
  const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, { ...options, redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        response.status === 429
          ? "provider_rate_limited"
          : response.status === 401 || response.status === 403
            ? "provider_unauthorized"
            : response.status === 404
              ? "listing_not_found"
              : "provider_unavailable",
      );
    }
    if (Number(response.headers.get("content-length") ?? 0) > 1_048_576 || response.body === null) {
      await response.body?.cancel();
      return failure("invalid_response");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let body = "",
      size = 0;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(new Error("API request expired"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        body += decoder.decode();
        break;
      }
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        return failure("invalid_response");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return { tag: "ok", value: body };
  } catch {
    return failure("provider_unavailable");
  } finally {
    if (abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
    if (reader !== undefined) {
      try {
        if (!complete) {
          await reader.cancel();
        }
      } finally {
        reader.releaseLock();
      }
    }
  }
}
export async function requestJson(
  fetcher: typeof fetch,
  url: URL,
  options: RequestInit,
  signal?: AbortSignal,
): Promise<ApiResult<unknown>> {
  const result = await requestText(fetcher, url, options, signal);
  if (result.tag === "err") {
    return result;
  }
  try {
    const value: unknown = JSON.parse(result.value);
    return { tag: "ok", value };
  } catch {
    return failure("invalid_response");
  }
}
