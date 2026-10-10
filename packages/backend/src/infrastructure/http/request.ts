import { timingSafeEqual } from "node:crypto";

import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";

type ApiRequest = Readonly<{
  method: string;
  path: string;
  url: string | null;
  keyword: string | null;
  requirements: string | null;
  authorization: string | null;
  operation: "lookup" | "compare";
  conditions: unknown;
  confirmed: boolean;
  comparisonMode?: "price" | "performance" | "ai";
  monitorSort?: "price" | "specifications";
  consumerSort?: "recommendation" | "price" | "specifications";
  consumerCategory?: string | null;
  comparisonJobId?: string;
  comparisonAccessKey?: string | null;
  idempotencyKey?: string;
}>;
type RequestError = Readonly<{ code: "invalid_request" | "invalid_url" }>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseAuthorization(headers: unknown): Result<string | null, RequestError> {
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
  return ok(authorization);
}

function parseComparisonAccessKey(headers: unknown): Result<string | null, RequestError> {
  if (!record(headers)) {
    return ok(null);
  }
  const entries = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-comparison-key",
  );
  if (entries.length > 1) {
    return err({ code: "invalid_request" });
  }
  const value = entries[0]?.[1] ?? null;
  if (value !== null && (typeof value !== "string" || !/^[a-zA-Z0-9_-]{32,256}$/.test(value))) {
    return err({ code: "invalid_request" });
  }
  return ok(value);
}

function validKeyword(keyword: unknown): keyword is string | null {
  if (keyword === null || keyword === undefined) {
    return true;
  }
  return (
    typeof keyword === "string" &&
    keyword.trim().length > 0 &&
    new TextEncoder().encode(keyword).length <= 128
  );
}

function validSourceUrl(url: unknown): url is string {
  return typeof url === "string" && url.length > 0 && url.length <= 2048;
}

function validConsumerSort(sort: unknown): sort is "recommendation" | "price" | "specifications" {
  return sort === "recommendation" || sort === "price" || sort === "specifications";
}

function parseComparisonJobPath(path: string): Readonly<{ id: string; cancel: boolean }> | null {
  const match = /^\/api\/comparisons\/([^/]+)(\/cancel)?$/.exec(path);
  if (match === null) {
    return null;
  }
  const id = match[1];
  if (id === undefined || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return null;
  }
  return Object.freeze({ id, cancel: match[2] === "/cancel" });
}

function routeNeedsDetailedBody(path: string, method: string): boolean {
  if (path === "/api/investigate") {
    return true;
  }
  if (path === "/api/candidates" || path === "/api/monitors" || path === "/api/compare") {
    return method === "POST";
  }
  if (path === "/api/detect" || path === "/api/comparisons") {
    return method === "POST";
  }
  return false;
}

export function parseApiRequest(input: unknown): Result<ApiRequest, RequestError> {
  if (!record(input) || typeof input["path"] !== "string" || typeof input["method"] !== "string") {
    return err({ code: "invalid_request" });
  }
  const method = input["method"];
  const path = input["path"];
  const headers = input["headers"];
  const authorization = parseAuthorization(headers);
  if (authorization.tag === "err") {
    return authorization;
  }
  const comparisonAccessKey = parseComparisonAccessKey(headers);
  if (comparisonAccessKey.tag === "err") {
    return comparisonAccessKey;
  }
  const comparisonJob = parseComparisonJobPath(path);
  if (comparisonJob !== null) {
    if (comparisonJob.cancel && method !== "POST") {
      return err({ code: "invalid_request" });
    }
    if (!comparisonJob.cancel && method !== "GET" && method !== "POST") {
      return err({ code: "invalid_request" });
    }
    return ok(
      Object.freeze({
        method,
        path,
        url: null,
        keyword: null,
        requirements: null,
        authorization: authorization.value,
        operation: "lookup",
        conditions: null,
        confirmed: false,
        comparisonJobId: comparisonJob.id,
        comparisonAccessKey: comparisonAccessKey.value,
      }),
    );
  }
  if (path === "/api/investigate" && method !== "GET" && method !== "POST") {
    return ok(
      Object.freeze({
        method,
        path,
        url: null,
        keyword: null,
        requirements: null,
        authorization: authorization.value,
        operation: "lookup",
        conditions: null,
        confirmed: false,
        comparisonAccessKey: comparisonAccessKey.value,
      }),
    );
  }
  if (path === "/api/catalog" && method === "GET") {
    return ok(
      Object.freeze({
        method,
        path,
        url: null,
        keyword: null,
        requirements: null,
        authorization: authorization.value,
        operation: "lookup",
        conditions: null,
        confirmed: false,
      }),
    );
  }
  if (!routeNeedsDetailedBody(path, method)) {
    return ok(
      Object.freeze({
        method,
        path,
        url: null,
        keyword: null,
        requirements: null,
        authorization: authorization.value,
        operation: "lookup",
        conditions: null,
        confirmed: false,
        comparisonAccessKey: comparisonAccessKey.value,
      }),
    );
  }
  if (method !== "GET" && method !== "POST") {
    return err({ code: "invalid_request" });
  }
  let url: unknown;
  let keyword: unknown = null;
  let operation: "lookup" | "compare" = "lookup";
  let conditions: unknown = null;
  let confirmed = false;
  if (method === "GET") {
    const query = input["query"];
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
    if (typeof body !== "string" || new TextEncoder().encode(body).length > 4096) {
      return err({ code: "invalid_request" });
    }
    try {
      const decoded: unknown = JSON.parse(body);
      if (!record(decoded)) {
        return err({ code: "invalid_request" });
      }
      if (path === "/api/detect") {
        const sourceUrl = decoded["url"];
        const sourceKeyword = decoded["keyword"] ?? null;
        if (!validSourceUrl(sourceUrl) || !validKeyword(sourceKeyword)) {
          return err({ code: "invalid_request" });
        }
        return ok(
          Object.freeze({
            method,
            path,
            url: sourceUrl,
            keyword: sourceKeyword,
            requirements: null,
            authorization: authorization.value,
            operation: "lookup",
            conditions: null,
            confirmed: false,
          }),
        );
      }
      if (path === "/api/comparisons") {
        const sourceUrl = decoded["url"];
        const sourceKeyword = decoded["keyword"] ?? null;
        const category = decoded["category"] ?? null;
        const sort = decoded["sort"];
        const idempotencyKey = decoded["idempotencyKey"];
        if (
          !validSourceUrl(sourceUrl) ||
          !validKeyword(sourceKeyword) ||
          !validConsumerSort(sort) ||
          typeof idempotencyKey !== "string" ||
          idempotencyKey.trim().length === 0 ||
          new TextEncoder().encode(idempotencyKey).length > 128 ||
          (category !== null &&
            (typeof category !== "string" || category.length === 0 || category.length > 64))
        ) {
          return err({ code: "invalid_request" });
        }
        return ok(
          Object.freeze({
            method,
            path,
            url: sourceUrl,
            keyword: sourceKeyword,
            requirements: null,
            authorization: authorization.value,
            operation: "compare",
            conditions: decoded["conditions"],
            confirmed: true,
            consumerSort: sort,
            consumerCategory: category,
            idempotencyKey,
            comparisonAccessKey: comparisonAccessKey.value,
          }),
        );
      }
      if (path === "/api/monitors" || path === "/api/compare") {
        const monitorSort = decoded["sort"];
        const sourceUrl = decoded["url"];
        const sourceKeyword = decoded["keyword"] ?? null;
        if (
          (monitorSort !== "price" &&
            monitorSort !== "specifications" &&
            !(path === "/api/compare" && monitorSort === "recommendation")) ||
          !validSourceUrl(sourceUrl) ||
          !validKeyword(sourceKeyword) ||
          (path === "/api/compare" &&
            decoded["category"] !== null &&
            (typeof decoded["category"] !== "string" || decoded["category"].length > 64))
        ) {
          return err({ code: "invalid_request" });
        }
        return ok(
          Object.freeze({
            method,
            path,
            url: sourceUrl,
            keyword: sourceKeyword,
            requirements: null,
            authorization: authorization.value,
            operation: "compare",
            conditions: decoded["conditions"],
            confirmed: true,
            ...(monitorSort === "price" || monitorSort === "specifications" ? { monitorSort } : {}),
            ...(path === "/api/compare" ? { consumerSort: monitorSort } : {}),
            ...(path === "/api/compare" &&
            (typeof decoded["category"] === "string" || decoded["category"] === null)
              ? { consumerCategory: decoded["category"] }
              : {}),
          }),
        );
      }
      conditions = decoded["conditions"] ?? null;
      confirmed = decoded["confirmed"] === true;
      if (
        decoded["operation"] !== undefined &&
        decoded["operation"] !== "lookup" &&
        decoded["operation"] !== "compare"
      ) {
        return err({ code: "invalid_request" });
      }
      if (decoded["operation"] === "compare") {
        operation = "compare";
      }
      if ((operation === "compare" || conditions !== null) && (!confirmed || conditions === null)) {
        return err({ code: "invalid_request" });
      }
      if (path === "/api/candidates") {
        const requirements = record(decoded) ? decoded["requirements"] : null;
        if (
          typeof requirements !== "string" ||
          requirements.trim().length === 0 ||
          requirements.length > (conditions === null ? 1000 : 200)
        ) {
          return err({ code: "invalid_request" });
        }
        const comparisonMode = decoded["comparisonMode"];
        if (
          comparisonMode !== undefined &&
          comparisonMode !== "price" &&
          comparisonMode !== "performance" &&
          comparisonMode !== "ai"
        ) {
          return err({ code: "invalid_request" });
        }
        const sourceUrl =
          conditions === null && comparisonMode === undefined ? null : decoded["url"];
        const sourceKeyword =
          conditions === null && comparisonMode === undefined ? null : (decoded["keyword"] ?? null);
        if (
          sourceUrl !== null &&
          (typeof sourceUrl !== "string" ||
            sourceUrl.trim().length === 0 ||
            sourceUrl.length > 2048)
        ) {
          return err({ code: "invalid_url" });
        }
        if (
          (conditions !== null || comparisonMode !== undefined) &&
          typeof sourceUrl !== "string"
        ) {
          return err({ code: "invalid_url" });
        }
        if (
          sourceKeyword !== null &&
          (typeof sourceKeyword !== "string" ||
            sourceKeyword.trim().length === 0 ||
            new TextEncoder().encode(sourceKeyword).length > 128)
        ) {
          return err({ code: "invalid_request" });
        }
        return ok(
          Object.freeze({
            method,
            path,
            url: sourceUrl,
            keyword: sourceKeyword,
            requirements: requirements.trim(),
            authorization: authorization.value,
            operation,
            conditions,
            confirmed,
            ...(comparisonMode === undefined ? {} : { comparisonMode }),
          }),
        );
      }
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
  return ok(
    Object.freeze({
      method,
      path,
      url,
      keyword,
      requirements: null,
      authorization: authorization.value,
      operation,
      conditions,
      confirmed,
    }),
  );
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

export function apiResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): ApiResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    }),
    body: JSON.stringify(body),
  });
}

export function corsPreflightResponse(allowedOrigin: string): ApiResponse {
  return apiResponse(204, "", {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,x-comparison-key",
    "access-control-max-age": "600",
  });
}

export function withCors(response: ApiResponse, allowedOrigin: string | null): ApiResponse {
  if (allowedOrigin === null) {
    return response;
  }
  return Object.freeze({
    ...response,
    headers: Object.freeze({ ...response.headers, "access-control-allow-origin": allowedOrigin }),
  });
}

function publicConsumerRoute(path: string, method: string): boolean {
  return (
    (path === "/api/catalog" && (method === "GET" || method === "OPTIONS")) ||
    ((path === "/api/detect" || path === "/api/comparisons") &&
      (method === "POST" || method === "OPTIONS")) ||
    (/^\/api\/comparisons\/[a-f0-9]{64}$/.test(path) && (method === "GET" || method === "OPTIONS"))
  );
}
function consumerOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("A valid public consumer origin is required");
  }
  return url.origin;
}
export function createPublicConsumerGateway(
  internal: (event: unknown) => Promise<ApiResponse>,
  settings: Readonly<{ accessToken: string | null; allowedOrigin?: string; clock?: () => number }>,
): (event: unknown, clientAddress: string, serverOrigin?: string) => Promise<ApiResponse> {
  if (settings.accessToken !== null && !/^[a-zA-Z0-9_-]{32,256}$/.test(settings.accessToken)) {
    throw new Error("A valid server API token is required");
  }
  const configuredOrigin =
    settings.allowedOrigin === undefined ? null : consumerOrigin(settings.allowedOrigin);
  const clock = settings.clock ?? Date.now;
  const buckets = new Map<string, Readonly<{ count: number; resetAt: number }>>();
  return async (event, clientAddress, serverOrigin) => {
    if (
      !record(event) ||
      typeof event["path"] !== "string" ||
      typeof event["method"] !== "string" ||
      !publicConsumerRoute(event["path"], event["method"])
    ) {
      return await internal(event);
    }
    const headers = event["headers"] === undefined ? {} : event["headers"];
    if (!record(headers)) {
      return apiResponse(400, err({ code: "invalid_request" }));
    }
    const origins = Object.entries(headers).filter(([name]) => name.toLowerCase() === "origin");
    const origin = origins[0]?.[1] ?? null;
    if (
      origins.length > 1 ||
      (origin !== null && (typeof origin !== "string" || origin.length > 512))
    ) {
      return apiResponse(400, err({ code: "invalid_request" }));
    }
    const expectedOrigin =
      configuredOrigin ?? (serverOrigin === undefined ? null : consumerOrigin(serverOrigin));
    if (origin !== null && origin !== expectedOrigin) {
      return apiResponse(403, err({ code: "origin_forbidden" }));
    }
    if (event["method"] === "OPTIONS") {
      return expectedOrigin === null ? apiResponse(204, "") : corsPreflightResponse(expectedOrigin);
    }
    const parsed = parseApiRequest(event);
    if (parsed.tag === "err") {
      return apiResponse(400, parsed);
    }
    if (settings.accessToken === null && parsed.value.path !== "/api/catalog") {
      return withCors(apiResponse(503, err({ code: "provider_unavailable" })), expectedOrigin);
    }
    if (parsed.value.method === "POST") {
      // ponytail: six costly requests per minute/address on one instance; move to a shared limiter if horizontally scaled.
      const now = clock();
      const address =
        clientAddress.length > 0 && clientAddress.length <= 128 ? clientAddress : "unknown";
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
      const bucket = buckets.get(address);
      if (
        (bucket !== undefined && bucket.count >= 6) ||
        (bucket === undefined && buckets.size >= 1024)
      ) {
        return withCors(
          apiResponse(429, err({ code: "consumer_rate_limited" }), { "retry-after": "60" }),
          expectedOrigin,
        );
      }
      buckets.set(address, {
        count: (bucket?.count ?? 0) + 1,
        resetAt: bucket?.resetAt ?? now + 60_000,
      });
    }
    const forwarded = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
    );
    if (settings.accessToken !== null) {
      forwarded["authorization"] = `Bearer ${settings.accessToken}`;
    }
    return withCors(await internal({ ...event, headers: forwarded }), expectedOrigin);
  };
}
