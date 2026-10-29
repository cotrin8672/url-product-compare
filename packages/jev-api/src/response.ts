/** Enforce the byte limit while reading, including responses without Content-Length. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted === true) {
    await response.body?.cancel();
    signal.throwIfAborted();
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  let complete = false;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new Error("response_read_aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        complete = true;
        return output + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        return null;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (abort !== undefined) {
      signal?.removeEventListener("abort", abort);
    }
    try {
      if (!complete) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
}
