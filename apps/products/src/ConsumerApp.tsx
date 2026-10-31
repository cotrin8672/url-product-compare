/** @jsxImportSource solid-js */
import { batch, createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  clearComparisonSession,
  comparisonDetailLayout,
  comparisonDisplayRemainingMs,
  comparisonJobCannotResume,
  comparisonErrorMessage,
  comparisonRecoveryAction,
  productCatalogFailure,
  normalizeProductUrl,
  createComparisonOperation,
  createComparisonRequestScope,
  detectProductCategory,
  fetchProductCatalog,
  isAutomaticCategory,
  parsePublicCompareRoute,
  pollConsumerComparisonJob,
  readActiveComparisonCategory,
  readComparisonSession,
  shouldPollJob,
  startConsumerComparisonJob,
  waitForComparisonPoll,
  writeComparisonSession,
} from "@app/api-client";
import type {
  ComparisonJob,
  ComparisonOperation,
  ComparisonRequest,
  ConsumerComparison,
  ConsumerSort,
  DetectResult,
  StoredComparisonSession,
} from "@app/api-client";
import { ServiceHeader } from "@app/ui";

type DisplayResult = Readonly<{ data: ConsumerComparison; expiresAt: string }>;
type PendingOperation = Readonly<{
  url: string;
  category: string;
  sort: ConsumerSort;
  keyword: string;
  operation: ComparisonOperation;
}>;

const fieldLabels: Readonly<Record<string, string>> = {
  "機種・対応機種（スマートフォン）": "スマホ対応",
  "機種・対応機種（タブレット）": "タブレット対応",
  "機種・対応機種（携帯電話）": "携帯電話対応",
  "素材（生地・毛糸）": "素材",
  "素材（時計ベルト）": "ベルト素材",
  時計の文字盤の代表カラー: "文字盤カラー",
  腕時計のフェイスの横のサイズ: "フェイス幅",
  腕時計のフェイスの縦のサイズ: "フェイス高さ",
  腕時計のベルトの幅: "ベルト幅",
  "メモリ（同時に作業する余裕）": "メモリ",
};

function productDisplayTitle(title: string): string {
  const name = title
    .replace(/【[^】]*】/g, "")
    .replace(
      /^(?:\s*(?:AI\s*PC|ノートパソコン|新品|office(?:付き|選択可)?|可能|軽量|薄型|おすすめ))+\s*/i,
      "",
    )
    .trim();
  return name.length === 0 ? title : name;
}

function Score(props: Readonly<{ value: number | null; label: string }>): JSX.Element {
  return (
    <Show
      when={props.value === null ? undefined : { value: props.value }}
      fallback={<span>—</span>}
    >
      {(score) => (
        <div class="consumer-score">
          <strong>
            {score().value}
            <small>/100</small>
          </strong>
          <progress max="100" value={score().value} aria-label={props.label} />
        </div>
      )}
    </Show>
  );
}

function CriteriaChart(
  props: Readonly<{
    product: ConsumerComparison["products"][number];
    axes: ConsumerComparison["categoryDefinition"]["axes"];
    fields: ConsumerComparison["categoryDefinition"]["fields"];
  }>,
): JSX.Element {
  return (
    <div class="criteria-chart">
      <For each={props.axes}>
        {(axis, index) => {
          const score = props.product.axes.find((entry) => entry.id === axis.id)?.score ?? null;
          const value = props.product.consumerInformation.specs[axis.id];
          const unit = props.fields.find((field) => field.id === axis.id)?.unit ?? "";
          return (
            <div classList={{ criterion: true, "consumer-criterion-teal": index() >= 2 }}>
              <span>
                {fieldLabels[axis.label] ?? axis.label}
                <Show when={typeof value === "number" ? { value } : undefined}>
                  {(known) => (
                    <small class="consumer-criterion-value">
                      {known().value.toLocaleString("ja-JP")}
                      {unit}
                    </small>
                  )}
                </Show>
              </span>
              <Show
                when={score === null ? undefined : { value: score }}
                fallback={
                  <>
                    <span class="empty-track" />
                    <span class="unknown">—</span>
                  </>
                }
              >
                {(known) => (
                  <>
                    <progress
                      max="100"
                      value={known().value}
                      aria-label={props.product.title + "・" + axis.label}
                    />
                    <span>{known().value}</span>
                  </>
                )}
              </Show>
            </div>
          );
        }}
      </For>
      <div class="chart-scale">
        <span>0</span>
        <span>100</span>
      </div>
    </div>
  );
}

function specificationText(product: ConsumerComparison["products"][number], id: string): string {
  const value = product.consumerInformation.specs[id];
  if (typeof value === "number") {
    return value.toLocaleString("ja-JP");
  }
  return typeof value === "string"
    ? value
    : value === true
      ? "あり"
      : value === false
        ? "なし"
        : "—";
}

function SpecificationRows(
  props: Readonly<{
    fields: ConsumerComparison["categoryDefinition"]["fields"];
    products: ConsumerComparison["products"];
  }>,
): JSX.Element {
  return (
    <For each={props.fields}>
      {(field) => (
        <tr class="consumer-detail-row">
          <th class="row-label" scope="row">
            {fieldLabels[field.label] ?? field.label}
            <Show when={field.unit.length > 0}>
              <small>{field.unit}</small>
            </Show>
          </th>
          <For each={props.products}>
            {(product) => (
              <td classList={{ "best-product": product.rank === 1 }}>
                <Show
                  when={specificationText(product, field.id).length > 60}
                  fallback={specificationText(product, field.id)}
                >
                  <details class="consumer-spec-value">
                    <summary>{specificationText(product, field.id).slice(0, 60)}…</summary>
                    <p>{specificationText(product, field.id)}</p>
                  </details>
                </Show>
              </td>
            )}
          </For>
        </tr>
      )}
    </For>
  );
}

function ConsumerResults(
  props: Readonly<{ result: DisplayResult; onExpire: () => void }>,
): JSX.Element {
  createEffect(() => {
    const timer = setTimeout(
      props.onExpire,
      comparisonDisplayRemainingMs(props.result.data, props.result.expiresAt),
    );
    onCleanup(() => {
      clearTimeout(timer);
    });
  });
  const data = props.result.data;
  const layout = comparisonDetailLayout(data.categoryDefinition, data.products);
  const primarySpecifications =
    data.categorySelectionStatus === undefined ? [] : layout.specificationFields.slice(0, 6);
  const detailSpecifications = layout.specificationFields.slice(primarySpecifications.length);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const hasDetails = layout.detailAxes.length > 0 || detailSpecifications.length > 0;
  const emphasized = (product: ConsumerComparison["products"][number]): boolean =>
    product.rank === 1;
  return (
    <section class="consumer-results" aria-label="比較結果">
      <div class="bar consumer-result-heading">
        <h1>
          {data.status === "ranked"
            ? data.sort === "price"
              ? "価格順"
              : "おすすめ順"
            : "商品比較"}
        </h1>
        <span class="consumer-category-label">
          {data.categoryDefinition.label} · 新品 {data.products.length}件
        </span>
      </div>
      <Show when={data.status === "no_match"}>
        <p class="consumer-result-status" role="status">
          新品の候補なし
        </p>
      </Show>
      <Show when={data.status === "needs_information" && data.sort === "recommendation"}>
        <span class="consumer-result-status" title="共通の仕様情報が不足しています" role="status">
          順位保留
        </span>
      </Show>
      <Show when={data.status !== "no_match" && data.products.length === 1}>
        <span class="consumer-result-status" role="status">
          入力商品のみ
        </span>
      </Show>
      <div class="table-wrap" tabindex="0" role="region" aria-label="商品比較表">
        <table
          class="comparison-table consumer-comparison-table"
          style={{ "--product-count": String(data.products.length) }}
        >
          <caption class="sr-only">{data.categoryDefinition.label}の商品比較</caption>
          <thead>
            <tr>
              <th class="row-label" scope="col">
                <span class="sr-only">商品</span>
              </th>
              <For each={data.products}>
                {(product) => (
                  <th
                    classList={{ "product-heading": true, "best-product": emphasized(product) }}
                    scope="col"
                  >
                    <div class="rank-line">
                      <Show when={product.rank}>
                        {(rank) => (
                          <>
                            <span class={`medal medal-${rank() <= 3 ? rank() : "other"}`}>
                              {rank()}
                            </span>
                            <span>
                              {data.products.filter((other) => other.rank === rank()).length > 1
                                ? "同率"
                                : ""}
                              {rank()}位
                            </span>
                          </>
                        )}
                      </Show>
                      <Show
                        when={
                          product.provider === data.source.provider &&
                          product.listingId === data.source.listingId
                        }
                      >
                        <span class="source-tag">入力商品</span>
                      </Show>
                    </div>
                    <div
                      class="product-image"
                      role="img"
                      aria-label={
                        product.title +
                        (product.imageUrl === null ? "の商品画像なし" : "の商品画像")
                      }
                      style={
                        product.imageUrl === null
                          ? {}
                          : { "background-image": "url(" + JSON.stringify(product.imageUrl) + ")" }
                      }
                    >
                      <Show
                        when={
                          product.imageUrl === null &&
                          (data.category === "laptop" || data.category === "desktop")
                        }
                      >
                        <svg
                          class="consumer-image-placeholder"
                          viewBox="0 0 160 112"
                          fill="none"
                          aria-hidden="true"
                        >
                          <rect
                            x="25"
                            y="18"
                            width="110"
                            height="70"
                            rx="5"
                            fill="#e8edf2"
                            stroke="currentColor"
                            stroke-width="2"
                          />
                          <rect x="32" y="25" width="96" height="56" rx="2" fill="#f7f9fb" />
                          <path
                            d="M25 88 12 97v3h136v-3l-13-9M66 96h28"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </div>
                    <details class="consumer-product-title">
                      <summary>
                        <h3>{productDisplayTitle(product.title)}</h3>
                      </summary>
                      <p>{product.title}</p>
                    </details>
                    <span class="consumer-shop-tag">{product.shopName}</span>
                    <Show when={product.availability === "unavailable"}>
                      <span class="consumer-stock-status">売り切れ</span>
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show when={data.products.some((product) => product.recommendationPercent !== null)}>
              <tr class="recommendation-row">
                <th class="row-label" scope="row">
                  おすすめ度<small>総合評価 / 100</small>
                </th>
                <For each={data.products}>
                  {(product) => (
                    <td classList={{ "best-product": emphasized(product) }}>
                      <Score
                        value={product.recommendationPercent}
                        label={product.title + "・総合"}
                      />
                    </td>
                  )}
                </For>
              </tr>
            </Show>
            <tr class="consumer-spec-row">
              <th class="row-label" scope="row">
                税込価格
              </th>
              <For each={data.products}>
                {(product) => (
                  <td classList={{ "best-product": emphasized(product) }}>
                    <div class="consumer-price">
                      <span class="consumer-price-value">
                        ¥{product.price.minimum.toLocaleString("ja-JP")}
                      </span>
                      <Show when={product.price.maximum !== product.price.minimum}>
                        <span class="consumer-price-range">
                          〜¥{product.price.maximum.toLocaleString("ja-JP")}
                        </span>
                      </Show>
                    </div>
                  </td>
                )}
              </For>
            </tr>
            <Show when={layout.primaryAxes.length > 0}>
              <tr class="criteria-row">
                <th class="row-label" scope="row">
                  評価の内訳<small>100点満点</small>
                </th>
                <For each={data.products}>
                  {(product) => (
                    <td classList={{ "best-product": emphasized(product) }}>
                      <CriteriaChart
                        product={product}
                        axes={layout.primaryAxes}
                        fields={data.categoryDefinition.fields}
                      />
                    </td>
                  )}
                </For>
              </tr>
            </Show>
            <SpecificationRows fields={primarySpecifications} products={data.products} />
          </tbody>
          <Show when={hasDetails}>
            <tbody id="consumer-comparison-details" hidden={!detailsOpen()}>
              <Show when={layout.detailAxes.length > 0}>
                <tr class="criteria-row consumer-detail-criteria">
                  <th class="row-label" scope="row">
                    詳細評価<small>100点満点</small>
                  </th>
                  <For each={data.products}>
                    {(product) => (
                      <td classList={{ "best-product": emphasized(product) }}>
                        <CriteriaChart
                          product={product}
                          axes={layout.detailAxes}
                          fields={data.categoryDefinition.fields}
                        />
                      </td>
                    )}
                  </For>
                </tr>
              </Show>
              <SpecificationRows fields={detailSpecifications} products={data.products} />
            </tbody>
          </Show>
          <tbody>
            <tr class="purchase-row">
              <th class="row-label" scope="row">
                <span class="sr-only">購入</span>
              </th>
              <For each={data.products}>
                {(product) => (
                  <td classList={{ "best-product": emphasized(product) }}>
                    <a
                      class="purchase-button"
                      href={product.affiliateUrl}
                      target="_blank"
                      rel="sponsored nofollow noopener noreferrer"
                    >
                      商品を見る <span aria-hidden="true">↗</span>
                    </a>
                  </td>
                )}
              </For>
            </tr>
          </tbody>
        </table>
      </div>
      <Show when={hasDetails}>
        <button
          type="button"
          class="consumer-details-toggle"
          aria-expanded={detailsOpen()}
          aria-controls="consumer-comparison-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span>
            {detailsOpen()
              ? "詳細項目を閉じる"
              : `詳細項目を表示（${layout.detailAxes.length + detailSpecifications.length}項目）`}
          </span>
          <span
            classList={{ "consumer-details-chevron": true, "is-open": detailsOpen() }}
            aria-hidden="true"
          >
            ▽
          </span>
        </button>
      </Show>
      <details class="consumer-method">
        <summary>比較条件</summary>
        <p>送料・ポイント・クーポンは含みません。「—」は未確認です。</p>
        <p>商品リンクにはアフィリエイト広告を含みます。</p>
        <Show when={data.scoreBasis !== undefined && data.scoreBasis.length > 0}>
          <p>
            採点項目：
            {data.categoryDefinition.axes
              .filter((axis) => data.scoreBasis?.includes(axis.id) === true)
              .map((axis) => axis.label)
              .join("・")}
          </p>
        </Show>
      </details>
    </section>
  );
}

export function ConsumerApp(): JSX.Element {
  const route = parsePublicCompareRoute(window.location.pathname);
  const scope = createComparisonRequestScope();
  const catalogController = new AbortController();
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [recovery, setRecovery] = createSignal<ReturnType<typeof comparisonRecoveryAction>>(null);
  const [keyword, setKeyword] = createSignal("");
  const [keywordVisible, setKeywordVisible] = createSignal(false);
  const [result, setResult] = createSignal<DisplayResult>();
  const [detection, setDetection] = createSignal<DetectResult>();
  const [session, setSession] = createSignal<StoredComparisonSession | null>(null);
  const [categoryId, setCategoryId] = createSignal<string | null>(
    route.category ?? readActiveComparisonCategory(),
  );
  const [pending, setPending] = createSignal<PendingOperation>();
  const sort = route.sort ?? "recommendation";
  const [catalog, { refetch }] = createResource(async () => {
    try {
      const definitions = await fetchProductCatalog({ signal: catalogController.signal });
      batch(() => {
        setError("");
        setRecovery(null);
      });
      return definitions;
    } catch (cause: unknown) {
      const failure = productCatalogFailure(cause);
      setError(failure.message);
      setRecovery(failure.recovery);
      return undefined;
    }
  });
  document.body.classList.add("consumer-ready");
  onCleanup(() => {
    scope.invalidate();
    catalogController.abort();
    document.body.classList.remove("consumer-ready");
  });

  const acceptJob = (job: ComparisonJob, request: ComparisonRequest): void => {
    if (!request.isCurrent()) {
      return;
    }
    const previous = session();
    if (previous?.jobId === job.id && job.revision < previous.revision) {
      throw new Error("再取得してください。");
    }
    const next = {
      jobId: job.id,
      accessKey: job.accessKey,
      expiresAt: job.expiresAt,
      revision: job.revision,
    };
    setSession(next);
    const category = job.result?.category ?? categoryId();
    if (category !== null) {
      setCategoryId(category);
      writeComparisonSession(category, next);
    }
    const compared = job.result;
    if (job.state === "succeeded" && compared !== null) {
      batch(() => {
        setResult({ data: compared, expiresAt: job.expiresAt });
        setUrl(compared.source.canonicalUrl);
        setPending(undefined);
        setKeywordVisible(false);
      });
    } else if (job.state === "failed" || job.state === "cancelled") {
      if (category !== null) {
        clearComparisonSession(category);
      }
      setSession(null);
      setPending(undefined);
      throw new Error(
        comparisonErrorMessage(
          job.state === "cancelled" ? "cancelled" : (job.error?.code ?? "internal_error"),
        ),
        { cause: { code: job.state === "cancelled" ? "cancelled" : job.error?.code } },
      );
    }
  };

  const followJob = async (initial: ComparisonJob, request: ComparisonRequest): Promise<void> => {
    let job = initial;
    while (request.isCurrent()) {
      acceptJob(job, request);
      if (!shouldPollJob(job.state)) {
        return;
      }
      await waitForComparisonPoll(request.signal);
      job = await pollConsumerComparisonJob(job.id, {
        comparisonKey: job.accessKey,
        signal: request.signal,
        expectedRevision: job.revision,
      });
    }
  };

  const fail = (cause: unknown, request: ComparisonRequest): void => {
    if (!request.isCurrent()) {
      return;
    }
    if (comparisonJobCannotResume(cause)) {
      const category = categoryId();
      if (category !== null) {
        clearComparisonSession(category);
      }
      setSession(null);
      setPending(undefined);
    }
    const action = comparisonRecoveryAction(cause);
    if (action === "keyword") {
      setKeywordVisible(true);
    }
    setRecovery(action);
    setError(
      cause instanceof TypeError || (cause instanceof Error && cause.name === "TimeoutError")
        ? "接続できませんでした。再試行してください"
        : cause instanceof Error
          ? cause.message
          : "比較できませんでした",
    );
  };

  const start = async (confirmedCategory?: string): Promise<void> => {
    const request = scope.begin();
    let sourceUrl = url().trim();
    batch(() => {
      setBusy(true);
      setError("");
      setRecovery(null);
      setDetection(undefined);
      setResult(undefined);
    });
    try {
      sourceUrl = normalizeProductUrl(sourceUrl);
      setUrl(sourceUrl);
      if (new TextEncoder().encode(keyword().trim()).length > 128) {
        throw new Error(comparisonErrorMessage("invalid_keyword"), {
          cause: { code: "invalid_keyword" },
        });
      }
      let category = confirmedCategory;
      if (category === undefined) {
        const detected = await detectProductCategory(sourceUrl, {
          signal: request.signal,
          keyword: keyword(),
        });
        if (!request.isCurrent()) {
          return;
        }
        setDetection(detected);
        if (detected.status === "needs_confirmation") {
          return;
        }
        if (detected.category === null) {
          throw new Error(
            detected.source !== null && detected.source.condition !== "new"
              ? comparisonErrorMessage("listing_not_eligible")
              : "この商品のカテゴリには対応していません。別の商品URLをお試しください。",
            {
              cause: {
                code:
                  detected.source !== null && detected.source.condition !== "new"
                    ? "listing_not_eligible"
                    : "unsupported_category",
              },
            },
          );
        }
        category = detected.category;
      }
      const previous = pending();
      const next =
        previous?.url === sourceUrl &&
        previous.category === category &&
        previous.sort === sort &&
        previous.keyword === keyword()
          ? previous
          : {
              url: sourceUrl,
              category,
              sort,
              keyword: keyword(),
              operation: createComparisonOperation(),
            };
      const oldCategory = categoryId();
      if (oldCategory !== null && next !== previous) {
        clearComparisonSession(oldCategory);
      }
      batch(() => {
        setDetection(undefined);
        setCategoryId(category);
        setSession(null);
        setPending(next);
      });
      const job = await startConsumerComparisonJob(
        {
          url: sourceUrl,
          category,
          conditions: {},
          keyword: keyword(),
          sort,
          idempotencyKey: next.operation.idempotencyKey,
        },
        { comparisonKey: next.operation.accessKey, signal: request.signal },
      );
      await followJob(job, request);
    } catch (cause: unknown) {
      fail(cause, request);
    } finally {
      if (request.isCurrent()) {
        setBusy(false);
      }
    }
  };

  const restore = async (saved: StoredComparisonSession): Promise<void> => {
    const request = scope.begin();
    setBusy(true);
    try {
      await followJob(
        await pollConsumerComparisonJob(saved.jobId, {
          comparisonKey: saved.accessKey,
          signal: request.signal,
          expectedRevision: saved.revision,
        }),
        request,
      );
    } catch (cause: unknown) {
      fail(cause, request);
    } finally {
      if (request.isCurrent()) {
        setBusy(false);
      }
    }
  };

  let restoreAttempted = false;
  createEffect(() => {
    const definitions = catalog();
    if (definitions === undefined || restoreAttempted) {
      return;
    }
    restoreAttempted = true;
    const category = categoryId();
    if (
      category === null ||
      (!definitions.categories.some((entry) => entry.id === category) &&
        !isAutomaticCategory(definitions, category))
    ) {
      return;
    }
    const saved = readComparisonSession(category);
    if (saved !== null) {
      setSession(saved);
      restore(saved).catch(() => setError("比較できませんでした。"));
    }
  });

  const originalRobots =
    document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "noindex,nofollow";
  createEffect(() => {
    const meta = document.querySelector('meta[name="robots"]') ?? document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute(
      "content",
      session() !== null ||
        window.location.search.length > 0 ||
        /^\/(?:jobs|results|private)(?:\/|$)/.test(window.location.pathname)
        ? "noindex,follow"
        : originalRobots,
    );
    if (meta.parentNode === null) {
      document.head.append(meta);
    }
  });

  return (
    <>
      <ServiceHeader current="products" />
      <main class="consumer-main" classList={{ "consumer-home": result() === undefined }}>
        <form
          id="consumer-form"
          class="url-panel"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy() && !catalog.loading) {
              if (catalog() === undefined) {
                Promise.resolve(refetch()).catch(() => setError("比較サービスに接続できません"));
                return;
              }
              start().catch(() => setError("比較できませんでした。"));
            }
          }}
        >
          <label for="consumer-url">商品URLを貼り付けて比較</label>
          <div class="search">
            <div class="url-input-wrap">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m10 14 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 0 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  transform="translate(1 0)"
                />
              </svg>
              <input
                id="consumer-url"
                name="url"
                type="text"
                inputmode="url"
                autocapitalize="off"
                spellcheck={false}
                required
                aria-label="商品URL"
                aria-invalid={recovery() === "edit"}
                aria-describedby={error().length > 0 ? "consumer-error" : undefined}
                maxLength={2048}
                placeholder="https://item.rakuten.co.jp/..."
                value={url()}
                disabled={busy()}
                onInput={(event) => {
                  scope.invalidate();
                  const category = categoryId();
                  if (category !== null) {
                    clearComparisonSession(category);
                  }
                  batch(() => {
                    setSession(null);
                    setPending(undefined);
                    setDetection(undefined);
                    setResult(undefined);
                    setError("");
                    setRecovery(null);
                    setKeyword("");
                    setKeywordVisible(false);
                    setUrl(event.currentTarget.value);
                  });
                }}
              />
            </div>
            <button
              class="primary-button compare-button"
              type="submit"
              disabled={
                busy() ||
                catalog.loading ||
                (catalog() === undefined && error().length > 0 && recovery() !== "retry")
              }
            >
              {busy()
                ? "比較中…"
                : error().length > 0 && catalog() === undefined
                  ? recovery() === "retry"
                    ? "再接続"
                    : "準備中"
                  : recovery() === "retry" || recovery() === "keyword"
                    ? "再試行"
                    : "比較する"}
            </button>
          </div>
          <Show when={keywordVisible()}>
            <div class="consumer-recovery-field">
              <label for="consumer-keyword">商品名</label>
              <input
                id="consumer-keyword"
                type="text"
                value={keyword()}
                maxLength={128}
                disabled={busy()}
                onInput={(event) => {
                  setPending(undefined);
                  setKeyword(event.currentTarget.value);
                }}
              />
            </div>
          </Show>
        </form>
        <Show when={detection()?.status === "needs_confirmation" ? detection() : undefined}>
          {(detected) => (
            <div class="consumer-category-choice" role="group" aria-label="商品のカテゴリ">
              <For each={detected().categories}>
                {(id) => (
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={busy()}
                    onClick={() => {
                      start(id).catch(() => {
                        setError("比較できませんでした。");
                      });
                    }}
                  >
                    {catalog()?.categories.find((entry) => entry.id === id)?.label ?? id}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={error().length > 0}>
          <p id="consumer-error" class="status error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={busy()}>
          <div class="consumer-spinner" role="status" aria-label="比較中" />
        </Show>
        <Show when={result()}>
          {(display) => (
            <ConsumerResults
              result={display()}
              onExpire={() => {
                const category = categoryId();
                if (category !== null) {
                  clearComparisonSession(category);
                }
                batch(() => {
                  setResult(undefined);
                  setSession(null);
                  setError("表示期限切れ");
                  setRecovery("retry");
                });
              }}
            />
          )}
        </Show>
      </main>
    </>
  );
}
