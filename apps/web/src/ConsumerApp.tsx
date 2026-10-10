/** @jsxImportSource solid-js */
import { batch, createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  clearComparisonSession,
  comparisonDetailLayout,
  comparisonDisplayRemainingMs,
  comparisonJobCannotResume,
  createComparisonOperation,
  createComparisonRequestScope,
  detectProductCategory,
  fetchProductCatalog,
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

type DisplayResult = Readonly<{ data: ConsumerComparison; expiresAt: string }>;
type PendingOperation = Readonly<{
  url: string;
  category: string;
  sort: ConsumerSort;
  operation: ComparisonOperation;
}>;

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
  }>,
): JSX.Element {
  return (
    <div class="criteria-chart">
      <For each={props.axes}>
        {(axis, index) => {
          const score = props.product.axes.find((entry) => entry.id === axis.id)?.score ?? null;
          return (
            <div classList={{ criterion: true, "consumer-criterion-teal": index() >= 2 }}>
              <span>{axis.label}</span>
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
  return typeof value === "string"
    ? value
    : value === true
      ? "あり"
      : value === false
        ? "なし"
        : "—";
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
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const hasDetails = layout.detailAxes.length > 0 || layout.specificationFields.length > 0;
  const highestScore = Math.max(
    ...data.products.map((product) => product.recommendationPercent ?? -1),
  );
  const emphasized = (product: ConsumerComparison["products"][number]): boolean =>
    product.rank === 1 ||
    (data.sort === "recommendation" &&
      product.recommendationPercent !== null &&
      product.recommendationPercent === highestScore);
  return (
    <section class="consumer-results" aria-label="比較結果">
      <div class="bar consumer-result-heading">
        <h1>{data.status === "ranked" ? "類似商品のおすすめランキング" : "類似商品の比較"}</h1>
        <span class="consumer-category-label">{data.categoryDefinition.label}</span>
      </div>
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
                    <h3 title={product.title}>{productDisplayTitle(product.title)}</h3>
                    <span class="consumer-shop-tag">{product.shopName}</span>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <tr class="recommendation-row">
              <th class="row-label" scope="row">
                おすすめ度<small>総合評価 / 100</small>
              </th>
              <For each={data.products}>
                {(product) => (
                  <td classList={{ "best-product": emphasized(product) }}>
                    <Score value={product.recommendationPercent} label={product.title + "・総合"} />
                  </td>
                )}
              </For>
            </tr>
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
                      <CriteriaChart product={product} axes={layout.primaryAxes} />
                    </td>
                  )}
                </For>
              </tr>
            </Show>
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
                        <CriteriaChart product={product} axes={layout.detailAxes} />
                      </td>
                    )}
                  </For>
                </tr>
              </Show>
              <For each={layout.specificationFields}>
                {(field) => (
                  <tr class="consumer-detail-row">
                    <th class="row-label" scope="row">
                      {field.label}
                    </th>
                    <For each={data.products}>
                      {(product) => (
                        <td classList={{ "best-product": emphasized(product) }}>
                          {specificationText(product, field.id)}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
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
          <span>{detailsOpen() ? "閉じる" : "もっと見る…"}</span>
          <span
            classList={{ "consumer-details-chevron": true, "is-open": detailsOpen() }}
            aria-hidden="true"
          >
            ▽
          </span>
        </button>
      </Show>
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
  const [result, setResult] = createSignal<DisplayResult>();
  const [detection, setDetection] = createSignal<DetectResult>();
  const [session, setSession] = createSignal<StoredComparisonSession | null>(null);
  const [categoryId, setCategoryId] = createSignal<string | null>(
    route.category ?? readActiveComparisonCategory(),
  );
  const [pending, setPending] = createSignal<PendingOperation>();
  const sort = route.sort ?? "recommendation";
  const [catalog] = createResource(async () => {
    try {
      return await fetchProductCatalog({ signal: catalogController.signal });
    } catch {
      setError("比較サービスに接続できません。");
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
      });
    } else if (job.state === "failed" || job.state === "cancelled") {
      if (category !== null) {
        clearComparisonSession(category);
      }
      setSession(null);
      setPending(undefined);
      throw new Error("比較できませんでした。");
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
    setError(cause instanceof Error ? cause.message : "比較できませんでした。");
  };

  const start = async (confirmedCategory?: string): Promise<void> => {
    const request = scope.begin();
    const sourceUrl = url().trim();
    batch(() => {
      setBusy(true);
      setError("");
      setResult(undefined);
    });
    try {
      let category = confirmedCategory;
      if (category === undefined) {
        const detected = await detectProductCategory(sourceUrl, { signal: request.signal });
        if (!request.isCurrent()) {
          return;
        }
        setDetection(detected);
        if (detected.status === "needs_confirmation") {
          return;
        }
        if (detected.category === null) {
          throw new Error("この商品は比較できません。");
        }
        category = detected.category;
      }
      const previous = pending();
      const next =
        previous?.url === sourceUrl && previous.category === category && previous.sort === sort
          ? previous
          : { url: sourceUrl, category, sort, operation: createComparisonOperation() };
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
    if (category === null || !definitions.categories.some((entry) => entry.id === category)) {
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
      <header class="top consumer-top">
        <div class="top-inner">
          <a class="brand" href="/">
            <svg class="brand-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path
                d="M16 3v25M5 7h22M9 29h14M7 7 2 18h10L7 7Zm18 0-5 11h10L25 7ZM2 18a5 5 0 0 0 10 0m8 0a5 5 0 0 0 10 0"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            商品比較
          </a>
        </div>
      </header>
      <main class="consumer-main">
        <form
          id="consumer-form"
          class="url-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy()) {
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
                type="url"
                required
                aria-label="商品URL"
                maxLength={2048}
                placeholder="商品URL"
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
                    setUrl(event.currentTarget.value);
                  });
                }}
              />
            </div>
            <button
              class="primary-button compare-button"
              type="submit"
              disabled={busy() || catalog() === undefined}
            >
              {busy() ? "比較中…" : "比較する"}
            </button>
          </div>
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
          <p class="status error" role="alert">
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
                  setError("再取得してください。");
                });
              }}
            />
          )}
        </Show>
      </main>
    </>
  );
}
