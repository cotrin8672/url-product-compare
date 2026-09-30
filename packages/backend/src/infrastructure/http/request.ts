import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";

type ApiRequest = Readonly<{
  method: string;
  path: string;
  url: string | null;
  keyword: string | null;
  authorization: string | null;
}>;
type RequestError = Readonly<{ code: "invalid_request" | "invalid_url" }>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function parseApiRequest(input: unknown): Result<ApiRequest, RequestError> {
  if (!record(input) || input["version"] !== "2.0" || typeof input["rawPath"] !== "string") {
    return err({ code: "invalid_request" });
  }
  const context = input["requestContext"];
  const http = record(context) ? context["http"] : null;
  if (!record(http) || typeof http["method"] !== "string") {
    return err({ code: "invalid_request" });
  }
  const method = http["method"];
  const path = input["rawPath"];
  const headers = input["headers"];
  if (headers !== undefined && !record(headers)) {
    return err({ code: "invalid_request" });
  }
  const authorizationHeaders = record(headers)
    ? Object.entries(headers).filter(([name]) => name.toLowerCase() === "authorization")
    : [];
  const authorization = authorizationHeaders[0]?.[1] ?? null;
  if (
    authorizationHeaders.length > 1 ||
    (authorization !== null && (typeof authorization !== "string" || authorization.length > 1024))
  ) {
    return err({ code: "invalid_request" });
  }
  if (path !== "/api/investigate" || (method !== "GET" && method !== "POST")) {
    return ok({ method, path, url: null, keyword: null, authorization });
  }
  let url: unknown;
  let keyword: unknown = null;
  if (method === "GET") {
    const query = input["rawQueryString"];
    if (typeof query !== "string" || query.length > 8192) {
      return err({ code: "invalid_request" });
    }
    const values = new URLSearchParams(query).getAll("url");
    if (values.length !== 1) {
      return err({ code: "invalid_url" });
    }
    url = values[0];
  } else {
    const body = input["body"];
    if (input["isBase64Encoded"] !== false || typeof body !== "string" || body.length > 4096) {
      return err({ code: "invalid_request" });
    }
    try {
      const decoded: unknown = JSON.parse(body);
      url = record(decoded) ? decoded["url"] : null;
      keyword = record(decoded) ? (decoded["keyword"] ?? null) : null;
    } catch {
      return err({ code: "invalid_request" });
    }
  }
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return err({ code: "invalid_url" });
  }
  if (
    keyword !== null &&
    (typeof keyword !== "string" ||
      keyword.trim().length === 0 ||
      new TextEncoder().encode(keyword).length > 128)
  ) {
    return err({ code: "invalid_request" });
  }
  return ok(Object.freeze({ method, path, url, keyword, authorization }));
}

export function authorized(authorization: string | null, token: string): boolean {
  const actual = new TextEncoder().encode(authorization ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type ApiResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export function apiResponse(statusCode: number, body: unknown): ApiResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }),
    body: JSON.stringify(body),
  });
}
import { timingSafeEqual } from "node:crypto";
