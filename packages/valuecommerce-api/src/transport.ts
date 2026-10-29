type Failure = Readonly<{
  tag: "err";
  error: Readonly<{
    code:
      | "provider_unavailable"
      | "provider_unauthorized"
      | "provider_rate_limited"
      | "invalid_response";
  }>;
}>;
function failure(code: Failure["error"]["code"]): Failure {
  return { tag: "err", error: { code } };
}

export async function requestJson(
  fetcher: typeof fetch,
  url: URL,
  parent?: AbortSignal,
): Promise<Readonly<{ tag: "ok"; value: unknown }> | Failure> {
  const deadline = AbortSignal.timeout(8000);
  const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, { redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        response.status === 429
          ? "provider_rate_limited"
          : response.status === 401 || response.status === 403
            ? "provider_unauthorized"
            : "provider_unavailable",
      );
    }
    if (Number(response.headers.get("content-length") ?? 0) > 1_048_576) {
      await response.body?.cancel();
      return failure("invalid_response");
    }
    if (response.body === null) {
      return failure("invalid_response");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "",
      size = 0;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(new Error("ValueCommerce request expired"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
    for (;;) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        complete = true;
        text += decoder.decode();
        break;
      }
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        return failure("invalid_response");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    try {
      const decoded: unknown = JSON.parse(text);
      return { tag: "ok", value: decoded };
    } catch {
      return failure("invalid_response");
    }
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
