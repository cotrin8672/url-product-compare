/** @jsxImportSource solid-js */
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
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

type Product = ConsumerComparison["products"][number];
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

function Score(
  props: Readonly<{ value: number | null; label: string; confirmed: string }>,
): JSX.Element {
  return (
    <Show
      when={props.value === null ? undefined : { value: props.value }}
      fallback={<span class="unknown">未確認</span>}
    >
      {(score) => (
        <div class="consumer-score">
          <strong>
            {score().value}
            <small>/100</small>
          </strong>
          <progress max="100" value={score().value} aria-label={props.label} />
          <small class="consumer-score-confirmed">{props.confirmed}</small>
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
                    <span class="unknown">未確認</span>
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
        : "未確認";
}

function SpecificationRows(
  props: Readonly<{
    fields: ConsumerComparison["categoryDefinition"]["fields"];
    products: ConsumerComparison["products"];
    emphasized: (product: Product) => boolean;
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
              <td classList={{ "best-product": props.emphasized(product) }}>
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

const observedTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function ResultLoading(props: Readonly<{ message: string; delayed: boolean }>): JSX.Element {
  const columns = ["入力した商品", "候補1", "候補2", "候補3", "候補4", "候補5"];
  return (
    <section class="consumer-results result-loading" aria-labelledby="loading-heading">
      <div class="loading-status" role="status" aria-live="polite">
        <span class="loading-spinner" aria-hidden="true" />
        <div>
          <h2 id="loading-heading">比較中</h2>
          <p class="sr-only">{props.message}</p>
          <Show when={props.delayed}>
            <p>処理に時間がかかっています。このままお待ちください。</p>
          </Show>
        </div>
      </div>
      <div class="table-wrap" aria-hidden="true" aria-busy="true">
        <table
          class="comparison-table consumer-comparison-table loading-table"
          style={{ "--product-count": "6" }}
        >
          <thead>
            <tr>
              <th class="row-label">商品</th>
              <For each={columns}>
                {(column) => (
                  <th class="product-heading">
                    <span class="loading-column-label">{column}</span>
                    <span class="skeleton skeleton-image" />
                    <span class="skeleton skeleton-line" />
                    <span class="skeleton skeleton-line skeleton-short" />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={["おすすめ度", "掲載価格", "主な仕様"]}>
              {(label) => (
                <tr>
                  <th class="row-label">{label}</th>
                  <For each={columns}>
                    {() => (
                      <td>
                        <span class="skeleton skeleton-line" />
                        <span class="skeleton skeleton-line skeleton-short" />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function priceDifference(
  product: ConsumerComparison["products"][number],
  source: ConsumerComparison["products"][number] | undefined,
): string | null {
  // Price ranges depend on the selected configuration, so only exact prices get a difference.
  if (
    source === undefined ||
    product.price.minimum !== product.price.maximum ||
    source.price.minimum !== source.price.maximum
  ) {
    return null;
  }
  const difference = product.price.minimum - source.price.minimum;
  return difference === 0
    ? "入力商品と同額"
    : "入力商品より¥" +
        Math.abs(difference).toLocaleString("ja-JP") +
        (difference < 0 ? "安い" : "高い");
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
  const primaryIds = new Set([
    ...data.categoryDefinition.mainFields,
    ...layout.specificationFields.slice(0, 3).map((field) => field.id),
    "screenInches",
  ]);
  const primarySpecifications = data.categoryDefinition.fields.filter((field) =>
    primaryIds.has(field.id),
  );
  const detailSpecifications = data.categoryDefinition.fields.filter(
    (field) =>
      !primaryIds.has(field.id) &&
      data.products.some((product) => {
        const value = product.consumerInformation.specs[field.id];
        return value !== null && value !== undefined;
      }),
  );
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const isSource = (product: Product): boolean =>
    product.provider === data.source.provider && product.listingId === data.source.listingId;
  const source = data.products.find(isSource);
  const hasRanking = data.products.some((product) => product.rank !== null);
  const scoredAxes = [...layout.primaryAxes, ...layout.detailAxes];
  const hasDetails = scoredAxes.length > 0 || detailSpecifications.length > 0;
  const eligible = data.products.filter((product) => product.status === "eligible");
  const scoreBasis =
    data.scoreBasis ??
    data.categoryDefinition.axes
      .filter(
        (axis) =>
          eligible.length >= 2 &&
          eligible.every((product) =>
            product.axes.some((entry) => entry.id === axis.id && entry.score !== null),
          ),
      )
      .map((axis) => axis.id);
  const [priceOrder, setPriceOrder] = createSignal(data.sort === "price");
  const priceRank = (product: Product): number =>
    1 + data.products.filter((other) => other.price.minimum < product.price.minimum).length;
  const emphasized = (product: Product): boolean =>
    priceOrder() ? priceRank(product) === 1 : product.rank === 1;
  // Every column follows the selected order, so position and rank never disagree.
  const products = createMemo(() =>
    priceOrder()
      ? data.products.toSorted((left, right) => left.price.minimum - right.price.minimum)
      : hasRanking
        ? data.products.toSorted(
            (left, right) =>
              (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY),
          )
        : data.products,
  );
  const position = (product: Product): number | null =>
    priceOrder() ? priceRank(product) : product.rank;
  const confirmedAxes = (product: Product): string => {
    const confirmed = scoredAxes.filter((axis) =>
      product.axes.some((entry) => entry.id === axis.id && entry.score !== null),
    ).length;
    return `内訳の評価可能項目 ${confirmed}/${scoredAxes.length}`;
  };
  return (
    <section class="consumer-results" aria-labelledby="consumer-results-heading">
      <header class="results-head">
        <div class="results-title">
          <h2 id="consumer-results-heading">比較結果</h2>
          <p>
            {data.categoryDefinition.label}・新品 {data.products.length}件
          </p>
        </div>
        <Show when={data.products.length > 1}>
          <select
            class="results-order"
            aria-label="商品の並び順"
            value={priceOrder() ? "price" : "default"}
            onChange={(event) => setPriceOrder(event.currentTarget.value === "price")}
          >
            <option value="default">{hasRanking ? "おすすめ順" : "標準"}</option>
            <option value="price">価格の安い順</option>
          </select>
        </Show>
      </header>
      <Show when={data.status === "no_match"}>
        <p class="results-status" role="status">
          新品の類似候補が見つかりませんでした。別の商品URLでお試しください。
        </p>
      </Show>
      <Show when={data.status === "needs_information" && data.sort === "recommendation"}>
        <p class="results-status" role="status">
          共通して確認できた仕様が足りないため、順位を保留しています。
        </p>
      </Show>
      <Show when={data.status !== "no_match" && data.products.length === 1}>
        <p class="results-status" role="status">
          比較できる類似候補が見つからず、入力した商品のみを表示しています。
        </p>
      </Show>
      <div class="table-wrap results-table-wrap" tabindex="0" role="region" aria-label="商品比較表">
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
              <For each={products()}>
                {(product) => (
                  <th
                    classList={{
                      "product-heading": true,
                      "best-product": emphasized(product),
                      "source-product": isSource(product),
                    }}
                    scope="col"
                  >
                    <div class="rank-line">
                      <Show when={position(product)}>
                        {(rank) => (
                          <span class="rank-badge">
                            <span class={`medal medal-${rank() <= 3 ? rank() : "other"}`}>
                              {rank()}
                            </span>
                            {priceOrder()
                              ? "安い順"
                              : data.products.filter((other) => other.rank === rank()).length > 1
                                ? `同率${rank()}位`
                                : `${rank()}位`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <div class="source-line">
                      <Show when={isSource(product)}>
                        <span class="source-tag">入力した商品</span>
                      </Show>
                    </div>
                    <div
                      classList={{ "product-image": true, "no-image": product.imageUrl === null }}
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
                      <Show when={product.imageUrl === null}>画像なし</Show>
                    </div>
                    <details class="consumer-product-title">
                      <summary>
                        <h3>{productDisplayTitle(product.title)}</h3>
                      </summary>
                      <p>{product.title}</p>
                    </details>
                    <span class="consumer-shop-tag">{product.shopName}</span>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show when={data.products.some((product) => product.recommendationPercent !== null)}>
              <tr class="recommendation-row">
                <th class="row-label" scope="row">
                  おすすめ度<small>共通{scoreBasis.length}項目の相対評価</small>
                </th>
                <For each={products()}>
                  {(product) => (
                    <td classList={{ "best-product": emphasized(product) }}>
                      <Score
                        value={product.recommendationPercent}
                        label={product.title + "・総合"}
                        confirmed={confirmedAxes(product)}
                      />
                    </td>
                  )}
                </For>
              </tr>
            </Show>
            <tr class="price-row">
              <th class="row-label" scope="row">
                掲載価格<small>送料等を含みません</small>
              </th>
              <For each={products()}>
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
                    <Show when={product.price.maximum !== product.price.minimum}>
                      <p class="consumer-price-note">構成により変わります</p>
                    </Show>
                    <Show when={data.products.length > 1 && priceRank(product) === 1}>
                      <span class="consumer-lowest">この中で最安</span>
                    </Show>
                    <Show when={isSource(product) ? null : priceDifference(product, source)}>
                      {(difference) => <p class="consumer-price-difference">{difference()}</p>}
                    </Show>
                    <p class="consumer-observed">
                      <time dateTime={product.observedAt}>
                        {observedTime.format(new Date(product.observedAt))}
                      </time>
                      時点
                      <Show when={product.availability === "unavailable"}>
                        <span class="consumer-stock-status">売り切れ</span>
                      </Show>
                    </p>
                  </td>
                )}
              </For>
            </tr>
            <SpecificationRows
              fields={primarySpecifications}
              products={products()}
              emphasized={emphasized}
            />
          </tbody>
          <Show when={hasDetails}>
            <tbody id="consumer-comparison-details" hidden={!detailsOpen()}>
              <Show when={scoredAxes.length > 0}>
                <tr class="criteria-row consumer-detail-criteria">
                  <th class="row-label" scope="row">
                    評価の内訳<small>今回の候補内の相対評価</small>
                  </th>
                  <For each={products()}>
                    {(product) => (
                      <td classList={{ "best-product": emphasized(product) }}>
                        <CriteriaChart
                          product={product}
                          axes={scoredAxes}
                          fields={data.categoryDefinition.fields}
                        />
                      </td>
                    )}
                  </For>
                </tr>
              </Show>
              <SpecificationRows
                fields={detailSpecifications}
                products={products()}
                emphasized={emphasized}
              />
            </tbody>
          </Show>
          <tfoot>
            <tr class="purchase-row">
              <th class="row-label" scope="row">
                <span class="sr-only">販売ページ</span>
              </th>
              <For each={products()}>
                {(product) => (
                  <td classList={{ "best-product": emphasized(product) }}>
                    <a
                      class="purchase-button"
                      href={product.affiliateUrl}
                      target="_blank"
                      rel="sponsored nofollow noopener noreferrer"
                    >
                      商品を見る
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M3 9l6-6M4.5 3H9v4.5" />
                      </svg>
                      <span class="sr-only">（楽天市場・新しいタブで開く）</span>
                    </a>
                  </td>
                )}
              </For>
            </tr>
          </tfoot>
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
          {detailsOpen() ? "詳細仕様・評価の内訳を閉じる" : "詳細仕様・評価の内訳を表示"}
        </button>
      </Show>
      <div class="results-foot">
        <Show when={data.products.some((product) => product.recommendationPercent !== null)}>
          <p class="results-source">
            総合点は候補間で共通して比較できた項目だけで計算します。未確認項目は0点にせず、総合点の対象から外します。
          </p>
        </Show>
        <p class="results-source">
          情報元：楽天市場。価格は確認時点の掲載価格で、送料・ポイント・クーポンを含みません。「商品を見る」は広告リンクです。
        </p>
        <details class="consumer-method">
          <summary>比較条件と点数の見方</summary>
          <ul>
            <li>
              候補は、入力した商品の情報をもとに楽天市場の新品から探した類似商品です。容量・構成・セット内容が入力した商品と同じとは限りません。
            </li>
            <li>価格は確認時点の掲載価格です。送料・ポイント・クーポンは含みません。</li>
            <li>
              おすすめ度と評価の内訳は、今回の候補で確認できた値を相対的に点数化した目安です。候補が変われば点数も変わり、実測の性能や満足度を示すものではありません。
            </li>
            <Show when={scoreBasis.length > 0}>
              <li>
                採点項目：
                {data.categoryDefinition.axes
                  .filter((axis) => scoreBasis.includes(axis.id))
                  .map((axis) => axis.label)
                  .join("・")}
              </li>
            </Show>
            <li>
              「未確認」は仕様を確認できなかった項目です。0点や機能なしを意味しません。商品名の記載と仕様の照合ができない場合も未確認と表示します。
            </li>
            <li>
              商品情報の整理に自動抽出やAIの補助を使う場合があります。購入前に販売ページで型番と仕様を確認してください。
            </li>
            <li>
              「商品を見る」はアフィリエイト広告のリンクです。報酬を点数や順位の計算に使うことはありません。
            </li>
          </ul>
        </details>
      </div>
    </section>
  );
}

export function ConsumerApp(): JSX.Element {
  const route = parsePublicCompareRoute(window.location.pathname);
  const scope = createComparisonRequestScope();
  const catalogController = new AbortController();
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [progressMessage, setProgressMessage] = createSignal("商品情報を確認しています…");
  const [delayed, setDelayed] = createSignal(false);
  createEffect(() => {
    setDelayed(false);
    if (!busy()) {
      return;
    }
    const timer = setTimeout(() => setDelayed(true), 20000);
    onCleanup(() => {
      clearTimeout(timer);
    });
  });
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
    if (job.state === "queued" || job.state === "running") {
      setProgressMessage(
        job.state === "queued"
          ? "比較処理の開始を待っています…"
          : "類似商品の検索・比較を進めています…",
      );
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
      setProgressMessage("入力した商品の情報を確認しています…");
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
              : "この商品は比較に対応していません。別の商品URLをお試しください。",
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
      setProgressMessage("比較処理を開始しています…");
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
    setProgressMessage("前回の比較結果を確認しています…");
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
      <div class="consumer-main">
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
          <label class="sr-only" for="consumer-url">
            商品URL
          </label>
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
            <div class="consumer-category-choice" role="group" aria-labelledby="category-choice">
              <p id="category-choice">商品の種類を選んでください</p>
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
          <ResultLoading message={progressMessage()} delayed={delayed()} />
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
      </div>
    </>
  );
}
