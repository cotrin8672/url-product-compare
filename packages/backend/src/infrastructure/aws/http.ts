import { isIP } from "node:net";

import { err } from "../../comparison/algebra.js";
import { record } from "../../comparison/values.js";
import { apiResponse, withCors } from "../http/request.js";
import type { ApiResponse } from "../http/request.js";

export function createLambdaHttpHandler(
  handle: (event: unknown, clientAddress: string) => Promise<ApiResponse>,
  options: Readonly<{ clock?: () => number; allowedOrigin?: string }> = {},
): (event: unknown) => Promise<ApiResponse> {
  // Reject bursts before DynamoDB access. This budget is per warm environment,
  // not a substitute for edge admission or an account-wide billing cap.
  const readAddresses = new Map<string, number>();
  let readWindow = -1;
  let reads = 0;
  const clock = options.clock ?? Date.now;
  return async (event) => {
    if (
      !record(event) ||
      event["version"] !== "2.0" ||
      !record(event["requestContext"]) ||
      !record(event["requestContext"]["http"]) ||
      !record(event["headers"]) ||
      typeof event["rawPath"] !== "string" ||
      typeof event["rawQueryString"] !== "string" ||
      typeof event["isBase64Encoded"] !== "boolean"
    ) {
      return apiResponse(400, err({ code: "invalid_request" }));
    }
    const context = event["requestContext"]["http"];
    const address = context["sourceIp"];
    const method = context["method"];
    const path = event["rawPath"];
    if (
      typeof address !== "string" ||
      isIP(address) === 0 ||
      typeof method !== "string" ||
      !path.startsWith("/api/") ||
      path.includes("%") ||
      path.includes("\\") ||
      path.includes("//") ||
      event["rawQueryString"].length > 8192
    ) {
      return apiResponse(400, err({ code: "invalid_request" }));
    }
    const body = event["body"] ?? "";
    if (
      typeof body !== "string" ||
      body.length > 8192 ||
      (event["isBase64Encoded"] &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body))
    ) {
      return apiResponse(413, err({ code: "invalid_request" }));
    }
    const decoded = event["isBase64Encoded"]
      ? Buffer.from(body, "base64")
      : Buffer.from(body, "utf8");
    if (decoded.byteLength > 4096) {
      return apiResponse(413, err({ code: "invalid_request" }));
    }
    if (method === "GET" && /^\/api\/comparisons\/[a-f0-9]{64}$/.test(path)) {
      const window = Math.floor(clock() / 60_000);
      if (window !== readWindow) {
        readAddresses.clear();
        reads = 0;
        readWindow = window;
      }
      const addressReads = readAddresses.get(address) ?? 0;
      if (reads >= 1200 || addressReads >= 240) {
        return withCors(
          apiResponse(429, err({ code: "consumer_rate_limited" }), {
            "retry-after": String(Math.max(1, 60 - (Math.floor(clock() / 1000) % 60))),
          }),
          options.allowedOrigin ?? null,
        );
      }
      readAddresses.set(address, addressReads + 1);
      reads += 1;
    }
    try {
      return await handle(
        {
          path,
          method,
          query: event["rawQueryString"],
          headers: event["headers"],
          body: new TextDecoder("utf-8", { fatal: true }).decode(decoded),
        },
        address,
      );
    } catch {
      return apiResponse(503, err({ code: "service_unavailable" }));
    }
  };
}
