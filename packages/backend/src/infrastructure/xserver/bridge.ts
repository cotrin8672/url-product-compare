import { createHmac, randomBytes } from "node:crypto";

import { record } from "../../comparison/values.js";

export type XserverBridge = (operation: string, input: unknown) => Promise<unknown>;

export function createXserverBridge(
  configuration: unknown,
  fetcher: typeof fetch = fetch,
): XserverBridge {
  if (
    !record(configuration) ||
    typeof configuration["url"] !== "string" ||
    typeof configuration["secret"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(configuration["secret"])
  ) {
    throw new Error("Invalid Xserver bridge configuration");
  }
  const endpoint = new URL(configuration["url"]);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.port !== "" ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(endpoint.hostname) ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(endpoint.hostname) ||
    /^\d+(?:\.\d+){3}$/.test(endpoint.hostname)
  ) {
    throw new Error("Bridge requires a fixed public HTTPS endpoint");
  }
  const secret = configuration["secret"];
  return async (operation, input) => {
    const body = JSON.stringify({ operation, input });
    if (Buffer.byteLength(body) > 600_000) {
      throw new Error("Storage request exceeds limit");
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}\n${nonce}\n${endpoint.pathname}\n${body}`)
      .digest("hex");
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        "x-bridge-time": timestamp,
        "x-bridge-nonce": nonce,
        "x-bridge-signature": signature,
      },
      body,
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error("Storage unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          break;
        }
        size += chunk.value.byteLength;
        if (size > 650_000) {
          throw new Error("Storage response exceeds limit");
        }
        chunks.push(chunk.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(result) || result["ok"] !== true) {
        throw new Error("Invalid storage response");
      }
      return result["value"];
    } finally {
      if (!complete) {
        await reader.cancel();
      }
      reader.releaseLock();
    }
  };
}
