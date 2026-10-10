import {
  authHeaders,
  categoryDefinition,
  isAutomaticCategory,
  parseComparisonJob,
  parseConsumerComparison,
  parseConsumerConditions,
  parseDetectResult,
  parseProductCatalog,
  readJsonResponse,
  resolveApiBase,
  validateProductUrl,
} from "./consumer-http.js";
import type {
  ApiRequestOptions,
  CatalogCategory,
  ComparisonJob,
  ConsumerComparison,
  ConsumerConditions,
  ConsumerSort,
  DetectResult,
  ProductCatalog,
} from "./consumer-http.js";

export type {
  CatalogCategory,
  ComparisonJob,
  ComparisonOperation,
  ConsumerComparison,
  ConsumerConditions,
  ConsumerSort,
  DetectResult,
  ProductCatalog,
  StoredComparisonSession,
} from "./consumer-http.js";
export {
  clearComparisonSession,
  comparisonJobCannotResume,
  createComparisonOperation,
  parseConsumerComparison,
  parseDetectResult,
  parseProductCatalog,
  parsePublicCompareRoute,
  isAutomaticCategory,
  parseComparisonJob,
  readActiveComparisonCategory,
  readComparisonSession,
  writeComparisonSession,
} from "./consumer-http.js";

let cachedCatalog: Readonly<{ base: string; catalog: ProductCatalog }> | null = null;

export function resetConsumerCatalogCache(): void {
  cachedCatalog = null;
}

async function fetchApi(
  path: string,
  init: RequestInit,
  options: ApiRequestOptions,
): Promise<unknown> {
  const base = resolveApiBase(options.apiBase);
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(58_000);
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
  });
  options.signal?.throwIfAborted();
  return await readJsonResponse(response);
}

export async function fetchProductCatalog(
  options: ApiRequestOptions = {},
): Promise<ProductCatalog> {
  const catalog = parseProductCatalog(
    await fetchApi("/api/catalog", { method: "GET", headers: authHeaders(options) }, options),
  );
  cachedCatalog = { base: resolveApiBase(options.apiBase), catalog };
  return catalog;
}

async function requireCatalog(options: ApiRequestOptions): Promise<ProductCatalog> {
  options.signal?.throwIfAborted();
  if (cachedCatalog !== null && cachedCatalog.base === resolveApiBase(options.apiBase)) {
    return cachedCatalog.catalog;
  }
  return await fetchProductCatalog(options);
}

function checkCategoryConditions(
  catalog: ProductCatalog,
  categoryId: string,
  conditions: ConsumerConditions,
): ConsumerConditions {
  const definition = categoryDefinition(catalog, categoryId);
  if (definition !== undefined) {
    return parseConsumerConditions(conditions, definition);
  }
  if (isAutomaticCategory(catalog, categoryId) && Object.keys(conditions).length === 0) {
    return Object.freeze({});
  }
  throw new Error("カテゴリと比較条件を確認してください");
}

export async function detectProductCategory(
  url: string,
  options: ApiRequestOptions & Readonly<{ keyword?: string }> = {},
): Promise<DetectResult> {
  const catalog = await requireCatalog(options);
  validateProductUrl(url, catalog.providers);
  const keyword =
    options.keyword === undefined || options.keyword.trim().length === 0
      ? null
      : options.keyword.trim();
  const detected = parseDetectResult(
    await fetchApi(
      "/api/detect",
      { method: "POST", headers: authHeaders(options), body: JSON.stringify({ url, keyword }) },
      options,
    ),
    catalog,
  );
  if (detected.categoryDefinition !== undefined) {
    cachedCatalog = {
      base: resolveApiBase(options.apiBase),
      catalog: {
        ...catalog,
        categories: [
          ...catalog.categories.filter(
            (category) => category.id !== detected.categoryDefinition?.id,
          ),
          detected.categoryDefinition,
        ],
      },
    };
  }
  return detected;
}

export async function startConsumerComparisonJob(
  input: Readonly<{
    url: string;
    category: string | null;
    conditions: ConsumerConditions;
    sort: ConsumerSort;
    keyword?: string;
    idempotencyKey: string;
  }>,
  options: ApiRequestOptions & Readonly<{ comparisonKey: string }>,
): Promise<ComparisonJob> {
  const catalog = await requireCatalog(options);
  validateProductUrl(input.url, catalog.providers);
  if (
    input.idempotencyKey.trim().length === 0 ||
    new TextEncoder().encode(input.idempotencyKey).byteLength > 128 ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(options.comparisonKey)
  ) {
    throw new Error("比較操作のキーを確認してください");
  }
  if (input.category !== null) {
    checkCategoryConditions(catalog, input.category, input.conditions);
  }
  const keyword =
    input.keyword === undefined || input.keyword.trim().length === 0 ? null : input.keyword.trim();
  const payload = {
    url: input.url,
    keyword,
    category: input.category,
    conditions: input.conditions,
    sort: input.sort,
    idempotencyKey: input.idempotencyKey,
  };
  const job = parseComparisonJob(
    await fetchApi(
      "/api/comparisons",
      { method: "POST", headers: authHeaders(options), body: JSON.stringify(payload) },
      options,
    ),
    catalog,
    options.comparisonKey,
  );
  return job;
}

export async function readConsumerComparisonJob(
  jobId: string,
  options: ApiRequestOptions & Readonly<{ comparisonKey: string }>,
): Promise<ComparisonJob> {
  const catalog = await requireCatalog(options);
  const job = parseComparisonJob(
    await fetchApi(
      `/api/comparisons/${encodeURIComponent(jobId)}`,
      { method: "GET", headers: authHeaders(options) },
      options,
    ),
    catalog,
    options.comparisonKey,
  );
  if (job.id !== jobId) {
    throw new Error("比較ジョブが一致しません");
  }
  return job;
}

export async function cancelConsumerComparisonJob(
  jobId: string,
  options: ApiRequestOptions & Readonly<{ comparisonKey: string }>,
): Promise<ComparisonJob> {
  const catalog = await requireCatalog(options);
  const job = parseComparisonJob(
    await fetchApi(
      `/api/comparisons/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", headers: authHeaders(options), body: "{}" },
      options,
    ),
    catalog,
    options.comparisonKey,
  );
  if (job.id !== jobId) {
    throw new Error("比較ジョブが一致しません");
  }
  return job;
}

export async function pollConsumerComparisonJob(
  jobId: string,
  options: ApiRequestOptions & Readonly<{ comparisonKey: string; expectedRevision?: number }>,
): Promise<ComparisonJob> {
  const job = await readConsumerComparisonJob(jobId, options);
  if (options.expectedRevision !== undefined && job.revision < options.expectedRevision) {
    throw new Error("比較ジョブの更新が古くなりました。再読み込みしてください");
  }
  return job;
}

export async function compareConsumerProducts(
  url: string,
  categoryId: string,
  input: ConsumerConditions,
  sort: ConsumerSort,
  options: ApiRequestOptions & Readonly<{ keyword?: string }> = {},
): Promise<ConsumerComparison> {
  const catalog = await requireCatalog(options);
  const checked = checkCategoryConditions(catalog, categoryId, input);
  const requested = validateProductUrl(url, catalog.providers);
  const provider = catalog.providers.find((entry) => entry.urlHosts.includes(requested.hostname));
  const expectedUrl =
    provider?.id === "rakuten"
      ? `${requested.origin}${requested.pathname.replace(/\/?$/, "/")}`
      : requested.href;
  const keyword =
    options.keyword === undefined || options.keyword.trim().length === 0
      ? null
      : options.keyword.trim();
  const result = parseConsumerComparison(
    await fetchApi(
      "/api/compare",
      {
        method: "POST",
        headers: authHeaders(options),
        body: JSON.stringify({ url, category: categoryId, conditions: checked, sort, keyword }),
      },
      options,
    ),
    catalog,
  );
  if (
    result.source.provider !== provider?.id ||
    new URL(result.source.canonicalUrl).href !== expectedUrl ||
    result.sort !== sort ||
    JSON.stringify(result.conditions) !== JSON.stringify(checked)
  ) {
    throw new Error("比較対象や条件が変わりました。再取得してください");
  }
  return result;
}

export function consumerCategories(catalog: ProductCatalog): readonly CatalogCategory[] {
  return catalog.categories;
}
