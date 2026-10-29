import { readBoundedResponseText } from "./response.js";

type ApiError = Readonly<{
  code:
    | "invalid_request"
    | "provider_unavailable"
    | "provider_unauthorized"
    | "provider_rate_limited"
    | "listing_not_found"
    | "invalid_response"
    | "invalid_json"
    | "invalid_response_size";
}>;
type ApiResult<T> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "err"; error: ApiError }>;
type Configuration = Readonly<{
  applicationId: string;
  accessKey: string;
  affiliateId: string;
  allowedOrigin: string;
}>;
type ItemSearch = Readonly<{
  keyword?: string;
  shopCode?: string;
  genreId?: string;
  itemCode?: string;
  hits?: number;
  page?: number;
  excludeKeyword?: string;
  elements?: readonly string[];
}>;
type Client = Readonly<{
  getAffiliateLink: (itemCode: string, signal?: AbortSignal) => Promise<ApiResult<string>>;
  searchItems: (
    input: ItemSearch,
    signal?: AbortSignal,
  ) => Promise<
    ApiResult<Readonly<{ count: number; items: ReadonlyArray<Readonly<Record<string, unknown>>> }>>
  >;
  genre: (
    genreId: string,
    signal?: AbortSignal,
  ) => Promise<ApiResult<Readonly<Record<string, unknown>>>>;
  searchProducts: (
    input: Readonly<{ keyword?: string; productCode?: string; hits?: number }>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<ApiResult<ReadonlyArray<Readonly<Record<string, unknown>>>>>;
}>;
const clients = new WeakMap<Configuration, WeakMap<typeof fetch, Client>>();
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function error(code: ApiError["code"]): ApiResult<never> {
  return Object.freeze({ tag: "err", error: Object.freeze({ code }) });
}
function ok<T>(value: T): ApiResult<T> {
  return Object.freeze({ tag: "ok", value });
}
function keyword(input: string | undefined): boolean {
  return (
    input === undefined ||
    (input.trim().length > 0 &&
      new TextEncoder().encode(input).length <= 128 &&
      !/\p{Cc}/u.test(input))
  );
}
function integer(input: number, maximum: number): boolean {
  return Number.isSafeInteger(input) && input >= 1 && input <= maximum;
}

/** Vendor protocol only: no backend imports, comparison policy, permissions, storage or AI. */
export function createRakutenClient(
  configuration: Configuration,
  fetcher: typeof fetch = fetch,
): Client {
  if (
    !/^[a-zA-Z0-9-]{8,128}$/.test(configuration.applicationId) ||
    !/^[a-zA-Z0-9_-]{16,512}$/.test(configuration.accessKey) ||
    !/^[a-fA-F0-9]{8}(?:\.[a-fA-F0-9]{8}){3}$/.test(configuration.affiliateId)
  ) {
    throw new Error("Invalid Rakuten API credentials");
  }
  const origin = new URL(configuration.allowedOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("Invalid Rakuten API origin");
  }
  const existing = clients.get(configuration)?.get(fetcher);
  if (existing !== undefined) {
    return existing;
  }
  // Every operation for this configuration/fetcher shares the 1.1 second pacing queue.
  let nextRequestAt = 0;
  let previous: Promise<void> = Promise.resolve();
  const request: typeof fetch = async (input, init) => {
    const result = previous.then(async () => {
      const signal = init?.signal ?? null;
      signal?.throwIfAborted();
      const wait = nextRequestAt - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new Error("Rakuten request expired"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, wait);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) {
            onAbort();
          }
        });
      }
      nextRequestAt = Date.now() + 1100;
      signal?.throwIfAborted();
      return await fetcher(input, init);
    });
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };
  async function get(
    path: string,
    parameters: Readonly<Record<string, string>>,
    parent: AbortSignal | undefined,
    maximumBytes: number,
    timeout: number,
    retry: boolean,
  ): Promise<ApiResult<unknown>> {
    const deadline = AbortSignal.timeout(timeout);
    const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
    try {
      signal.throwIfAborted();
      const endpoint = new URL(path, "https://openapi.rakuten.co.jp");
      endpoint.search = new URLSearchParams({
        applicationId: configuration.applicationId,
        format: "json",
        formatVersion: "2",
        ...parameters,
      }).toString();
      const options: RequestInit = {
        headers: { accessKey: configuration.accessKey, Origin: origin.origin },
        redirect: "error",
        signal,
      };
      let response: Response;
      let retried = false;
      try {
        response = await request(endpoint, options);
      } catch {
        signal.throwIfAborted();
        if (!retry) {
          throw new Error("Rakuten transport unavailable");
        }
        retried = true;
        response = await request(endpoint, options);
      }
      if (retry && !retried && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        response = await request(endpoint, options);
      }
      if (!response.ok) {
        await response.body?.cancel();
        return error(
          response.status === 400
            ? "invalid_request"
            : response.status === 401 || response.status === 403
              ? "provider_unauthorized"
              : response.status === 429
                ? "provider_rate_limited"
                : response.status === 404
                  ? "listing_not_found"
                  : "provider_unavailable",
        );
      }
      const text = await readBoundedResponseText(response, maximumBytes, signal);
      if (text === null) {
        return error("invalid_response_size");
      }
      signal.throwIfAborted();
      try {
        const decoded: unknown = JSON.parse(text);
        return ok(decoded);
      } catch {
        return error("invalid_json");
      }
    } catch {
      return error("provider_unavailable");
    }
  }
  const client: Client = Object.freeze({
    async getAffiliateLink(itemCode, signal) {
      const result = await client.searchItems(
        { itemCode, hits: 1, elements: ["count", "itemCode", "itemUrl", "affiliateUrl"] },
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      const item = result.value.items[0];
      if (item === undefined) {
        return error("listing_not_found");
      }
      if (
        item["itemCode"] !== itemCode ||
        typeof item["itemUrl"] !== "string" ||
        typeof item["affiliateUrl"] !== "string"
      ) {
        return error("invalid_response");
      }
      try {
        const destination = new URL(item["itemUrl"]),
          link = new URL(item["affiliateUrl"]);
        if (
          [destination, link].some(
            (url) =>
              url.protocol !== "https:" ||
              url.username !== "" ||
              url.password !== "" ||
              url.port !== "" ||
              url.hash !== "",
          ) ||
          destination.hostname !== "item.rakuten.co.jp" ||
          link.hostname !== "hb.afl.rakuten.co.jp" ||
          link.pathname !== "/hgc/" + configuration.affiliateId + "/" ||
          link.searchParams.getAll("pc").length !== 1 ||
          link.searchParams.get("pc") !== destination.href
        ) {
          return error("invalid_response");
        }
        return ok(link.href);
      } catch {
        return error("invalid_response");
      }
    },
    async searchItems(input, signal) {
      const hits = input.hits ?? 30,
        page = input.page ?? 1;
      if (
        !integer(hits, 30) ||
        !integer(page, 100) ||
        !keyword(input.keyword) ||
        !keyword(input.excludeKeyword) ||
        (input.shopCode !== undefined && !/^[a-zA-Z0-9_-]+$/.test(input.shopCode)) ||
        (input.genreId !== undefined && !/^\d{1,6}$/.test(input.genreId)) ||
        (input.itemCode !== undefined && !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(input.itemCode)) ||
        (input.keyword === undefined &&
          input.shopCode === undefined &&
          input.genreId === undefined &&
          input.itemCode === undefined) ||
        (input.elements !== undefined &&
          (input.elements.length > 100 ||
            input.elements.some((element) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(element))))
      ) {
        return error("invalid_request");
      }
      const result = await get(
        "/ichibams/api/IchibaItem/Search/20260701",
        {
          affiliateId: configuration.affiliateId,
          availability: "0",
          hits: String(hits),
          page: String(page),
          ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
          ...(input.shopCode === undefined ? {} : { shopCode: input.shopCode }),
          ...(input.genreId === undefined ? {} : { genreId: input.genreId }),
          ...(input.itemCode === undefined ? {} : { itemCode: input.itemCode }),
          ...(input.excludeKeyword === undefined ? {} : { NGKeyword: input.excludeKeyword }),
          ...(input.elements === undefined ? {} : { elements: input.elements.join(",") }),
        },
        signal,
        1_048_576,
        8000,
        true,
      );
      if (result.tag === "err") {
        return result;
      }
      const body = result.value;
      if (
        !record(body) ||
        typeof body["count"] !== "number" ||
        !Number.isSafeInteger(body["count"]) ||
        body["count"] < 0
      ) {
        return error("invalid_response");
      }
      // The docs show lower-case items; historical responses also use Items. Reject conflicting containers.
      if (body["Items"] !== undefined && body["items"] !== undefined) {
        return error("invalid_response");
      }
      const raw = body["Items"] ?? body["items"] ?? (body["count"] === 0 ? [] : undefined);
      if (!Array.isArray(raw) || raw.length > hits) {
        return error("invalid_response");
      }
      const entries: readonly unknown[] = raw;
      const items: Array<Readonly<Record<string, unknown>>> = [];
      for (const item of entries) {
        if (!record(item)) {
          return error("invalid_response");
        }
        items.push(Object.freeze({ ...item }));
      }
      return ok(Object.freeze({ count: body["count"], items: Object.freeze(items) }));
    },
    async genre(genreId, signal) {
      if (!/^\d{1,6}$/.test(genreId)) {
        return error("invalid_request");
      }
      const result = await get(
        "/ichibagt/api/IchibaGenre/Search/20260701",
        { genreId },
        signal,
        262144,
        5000,
        false,
      );
      if (result.tag === "err") {
        return result;
      }
      const body = result.value;
      if (
        !record(body) ||
        !record(body["genre"]) ||
        !Array.isArray(body["ancestors"]) ||
        body["ancestors"].length > 10
      ) {
        return error("invalid_response");
      }
      return ok(Object.freeze({ ...body }));
    },
    async searchProducts(input, signal, timeoutMs = 8000) {
      const hits = input.hits ?? 10;
      if (
        !integer(hits, 30) ||
        !integer(timeoutMs, 8000) ||
        !keyword(input.keyword) ||
        (input.productCode !== undefined && !/^\d{8,14}$/.test(input.productCode)) ||
        (input.productCode !== undefined && input.keyword !== undefined) ||
        (input.keyword === undefined && input.productCode === undefined)
      ) {
        return error("invalid_request");
      }
      const result = await get(
        "/ichibaproduct/api/Product/Search/20250801",
        {
          ...(input.productCode === undefined ? { hits: String(hits) } : {}),
          ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
          ...(input.productCode === undefined ? {} : { productCode: input.productCode }),
        },
        signal,
        1_048_576,
        timeoutMs,
        false,
      );
      if (result.tag === "err") {
        return result;
      }
      const body = result.value;
      if (!record(body) || !Array.isArray(body["Products"]) || body["Products"].length > hits) {
        return error("invalid_response");
      }
      const products: readonly unknown[] = body["Products"];
      const checked: Array<Readonly<Record<string, unknown>>> = [];
      for (const product of products) {
        if (!record(product)) {
          return error("invalid_response");
        }
        checked.push(Object.freeze({ ...product }));
      }
      return ok(Object.freeze(checked));
    },
  });
  const scoped = clients.get(configuration) ?? new WeakMap<typeof fetch, Client>();
  scoped.set(fetcher, client);
  clients.set(configuration, scoped);
  return client;
}
