/** @jsxImportSource solid-js */
import { batch, createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  createComparisonRequestScope,
  fetchCommerceListings,
  fetchCommerceSources,
  fetchFurusatoComparison,
} from "@app/api-client";
import type {
  CommerceListing,
  CommercePage,
  FurusatoComparison,
  FurusatoField,
} from "@app/api-client";
import { ServiceHeader } from "@app/ui";

type Source = "rakuten_furusato" | "satofull";
type Entry = Readonly<{ source: Source; data: CommercePage | null; error: string | null }>;
type Selection = Readonly<{ listing: CommerceListing; source: Source }>;
type Item = FurusatoComparison["items"][number];

const sources = [
  { id: "rakuten_furusato", label: "楽天ふるさと納税" },
  { id: "satofull", label: "さとふる" },
] satisfies ReadonlyArray<Readonly<{ id: Source; label: string }>>;
const categories: Readonly<Record<string, string>> = {
  rice: "米",
  meat: "肉",
  fruit: "果物",
  seafood: "魚介",
};
const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 3 });

function preparePage(): void {
  document.title = "ふるさと納税の返礼品比較";
}

function expiryDelay(listings: readonly CommerceListing[]): number {
  return Math.max(
    0,
    Math.min(...listings.map((listing) => Date.parse(listing.expiresAt))) - Date.now(),
  );
}

function sourceLabel(source: string): string {
  return sources.find((entry) => entry.id === source)?.label ?? source;
}

function key(listing: CommerceListing): string {
  return `${listing.source}:${listing.id}`;
}

function amount(listing: CommerceListing): string {
  const value = listing.amount;
  return value === null
    ? "—"
    : `${yen.format(value.minimum)}${value.minimum === value.maximum ? "" : `〜${yen.format(value.maximum)}`}`;
}

function fieldValue(field: FurusatoField | undefined): string {
  if (field === undefined || field.status === "unknown") {
    return "—";
  }
  if (field.status === "conflict") {
    return "記載不一致";
  }
  if (typeof field.value === "number") {
    return field.unit === "g"
      ? field.value >= 1000
        ? `${number.format(field.value / 1000)} kg`
        : `${number.format(field.value)} g`
      : `${number.format(field.value)}${field.unit ?? ""}`;
  }
  if (field.id === "category") {
    return categories[String(field.value)] ?? "—";
  }
  if (field.id === "deliveryMode") {
    return field.value === "subscription" ? "定期便" : "単発";
  }
  return field.value ?? "—";
}

function field(item: Item | undefined, id: string): FurusatoField | undefined {
  return id === "category" ? item?.category : item?.fields.find((entry) => entry.id === id);
}

function errorMessage(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  if (code === "not_configured" || code === "source_not_authorized") {
    return "現在利用できません";
  }
  if (code === "provider_rate_limited") {
    return "混み合っています。時間をおいて再試行してください";
  }
  if (code === "listing_not_found") {
    return "返礼品が見つかりません。選び直してください";
  }
  return "取得できませんでした。再試行してください";
}

function ProductImage(props: Readonly<{ listing: CommerceListing }>): JSX.Element {
  return (
    <div
      class="furu-product-image"
      role="img"
      aria-label={`${props.listing.title}${props.listing.imageUrl === null ? "：画像なし" : "の商品画像"}`}
      style={
        props.listing.imageUrl === null
          ? {}
          : { "background-image": `url(${JSON.stringify(props.listing.imageUrl)})` }
      }
    >
      <Show when={props.listing.imageUrl === null}>
        <span class="furu-image-missing">画像なし</span>
      </Show>
    </div>
  );
}

function ComparisonTable(props: Readonly<{ data: CommercePage }>): JSX.Element {
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [differencesOnly, setDifferencesOnly] = createSignal(false);
  const items = () => props.data.furusato?.items ?? [];
  const scoring = () => props.data.furusato?.scoring;
  const scoreStatus = (): string => {
    switch (scoring()?.status) {
      case "applied":
        return "Jev比較スコア";
      case "not_configured":
        return "採点準備中";
      case "not_authorized":
        return "採点利用未許可";
      case "needs_information":
        return "採点情報不足";
      case "unavailable":
        return "採点を取得できませんでした";
      case undefined:
        return "未採点";
    }
  };
  const rows = () => {
    const definitions = [
      { id: "category", label: "カテゴリ" },
      { id: "deliveryMode", label: "配送タイプ" },
      { id: "totalGrams", label: "総内容量" },
      { id: "perDeliveryGrams", label: "1回の内容量" },
      { id: "deliveryCount", label: "配送回数" },
      ...items()
        .flatMap((item) => item.fields)
        .filter(
          (entry) =>
            !["deliveryMode", "totalGrams", "perDeliveryGrams", "deliveryCount"].includes(entry.id),
        )
        .map((entry) => ({ id: entry.id, label: entry.label })),
    ];
    return definitions.filter(
      (row, index) =>
        definitions.findIndex((other) => other.id === row.id) === index &&
        (index < 5 ||
          items().some(
            (item) =>
              field(item, row.id)?.status !== "unknown" && field(item, row.id) !== undefined,
          )) &&
        (["deliveryMode", "totalGrams"].includes(row.id) ||
          !differencesOnly() ||
          new Set(items().map((item) => fieldValue(field(item, row.id)))).size > 1),
    );
  };
  return (
    <section class="furu-comparison" aria-labelledby="furu-result-heading">
      <div class="furu-section-heading">
        <h2 id="furu-result-heading" tabindex="-1">
          返礼品の比較 <span>{props.data.listings.length}件</span>
          <span class="furu-score-status">{scoreStatus()}</span>
        </h2>
        <Show when={detailsOpen()}>
          <label class="furu-differences">
            <input
              type="checkbox"
              checked={differencesOnly()}
              onChange={(event) => setDifferencesOnly(event.currentTarget.checked)}
            />
            違う項目だけ
          </label>
        </Show>
      </div>
      <div class="table-wrap furu-table-wrap" tabindex="0" role="region" aria-label="返礼品比較表">
        <table
          class="comparison-table furu-table"
          style={{ "--product-count": String(props.data.listings.length) }}
        >
          <caption class="sr-only">返礼品の寄付額・内容量・配送条件の比較</caption>
          <thead>
            <tr>
              <th class="row-label" scope="col">
                比較項目
              </th>
              <For each={props.data.listings}>
                {(listing, index) => (
                  <th scope="col" class="furu-column-heading">
                    <div class="furu-card-meta">
                      <span class="furu-column-number">{index() + 1}</span>
                      <Show when={scoring()?.items[index()]?.rank ?? undefined}>
                        {(rank) => <span class="furu-rank">{rank()}位</span>}
                      </Show>
                      <span class={`furu-source furu-source-${listing.source}`}>
                        {sourceLabel(listing.source)}
                      </span>
                    </div>
                    <ProductImage listing={listing} />
                    <h3>{listing.title}</h3>
                    <Show when={listing.availability === "unavailable"}>
                      <span class="furu-unavailable">受付終了</span>
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <tr class="furu-score-row">
              <th class="row-label" scope="row">
                比較スコア<small>/ 100</small>
              </th>
              <For each={props.data.listings}>
                {(listing, index) => (
                  <td>
                    <Show
                      when={
                        scoring()?.items[index()]?.score === null ||
                        scoring()?.items[index()]?.score === undefined
                          ? undefined
                          : scoring()?.items[index()]
                      }
                      fallback={<span class="unknown">—</span>}
                    >
                      {(item) => (
                        <>
                          <strong class="furu-score">{item().score}</strong>
                          <progress
                            max="100"
                            value={item().score ?? 0}
                            aria-label={`${listing.title}の比較スコア ${item().score ?? 0}点`}
                          />
                        </>
                      )}
                    </Show>
                  </td>
                )}
              </For>
            </tr>
            <tr class="furu-donation-row">
              <th class="row-label" scope="row">
                寄付額
              </th>
              <For each={props.data.listings}>
                {(listing) => (
                  <td>
                    <strong>{amount(listing)}</strong>
                  </td>
                )}
              </For>
            </tr>
            <For each={rows().filter((row) => ["deliveryMode", "totalGrams"].includes(row.id))}>
              {(row) => (
                <tr>
                  <th class="row-label" scope="row">
                    {row.label}
                  </th>
                  <For each={items()}>
                    {(item) => (
                      <td classList={{ unknown: field(item, row.id)?.status !== "known" }}>
                        {fieldValue(field(item, row.id))}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <tr>
              <th class="row-label" scope="row">
                1kgあたりの寄付額
              </th>
              <For each={items()}>
                {(item) => (
                  <td>
                    {item.donationPerKg === null ? (
                      <span class="unknown">—</span>
                    ) : (
                      yen.format(item.donationPerKg)
                    )}
                  </td>
                )}
              </For>
            </tr>
          </tbody>
          <tbody id="furusato-comparison-details" hidden={!detailsOpen()}>
            <For each={rows().filter((row) => !["deliveryMode", "totalGrams"].includes(row.id))}>
              {(row) => (
                <tr>
                  <th class="row-label" scope="row">
                    {row.label}
                  </th>
                  <For each={items()}>
                    {(item) => (
                      <td classList={{ unknown: field(item, row.id)?.status !== "known" }}>
                        {fieldValue(field(item, row.id))}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
          <tbody>
            <tr class="purchase-row">
              <th class="row-label" scope="row">
                寄付サイト <small>広告</small>
              </th>
              <For each={props.data.listings}>
                {(listing) => (
                  <td>
                    <Show
                      when={listing.availability !== "unavailable"}
                      fallback={<span class="unknown">受付終了</span>}
                    >
                      <a
                        class="purchase-button"
                        href={listing.affiliateUrl}
                        target="_blank"
                        rel="sponsored noopener noreferrer"
                      >
                        返礼品を見る <span aria-hidden="true">↗</span>
                      </a>
                    </Show>
                  </td>
                )}
              </For>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        type="button"
        class="consumer-details-toggle"
        aria-expanded={detailsOpen()}
        aria-controls="furusato-comparison-details"
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span>{detailsOpen() ? "詳細項目を閉じる" : "詳細項目を表示"}</span>
        <span
          classList={{ "consumer-details-chevron": true, "is-open": detailsOpen() }}
          aria-hidden="true"
        >
          ▽
        </span>
      </button>
      <div class="furu-pairs" aria-label="返礼品同士の比較条件">
        <For each={props.data.furusato?.pairs}>
          {(pair) => (
            <span
              classList={{ "furu-pair": true, "furu-pair-matched": pair.unitDonationComparable }}
            >
              <b>
                {pair.left + 1} × {pair.right + 1}
              </b>
              {pair.status === "comparable"
                ? "主要条件一致"
                : pair.status === "incompatible"
                  ? "カテゴリ違い"
                  : "条件差・未確認あり"}
            </span>
          )}
        </For>
      </div>
    </section>
  );
}

export function FurusatoApp(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [source, setSource] = createSignal<Source | "all">("all");
  const [entries, setEntries] = createSignal<readonly Entry[]>([]);
  const [selected, setSelected] = createSignal<readonly Selection[]>([]);
  const [result, setResult] = createSignal<CommercePage>();
  const [busy, setBusy] = createSignal<"search" | "compare" | null>(null);
  const [error, setError] = createSignal("");
  const [activeSearch, setActiveSearch] =
    createSignal<Readonly<{ query: string; source: Source | "all"; page: number }>>();
  const [sort, setSort] = createSignal("original");
  const scope = createComparisonRequestScope();
  const configurationController = new AbortController();
  const [configuration, { refetch }] = createResource(async () => {
    try {
      return {
        sources: await fetchCommerceSources({ signal: configurationController.signal }),
        error: false,
      };
    } catch {
      return { sources: [], error: true };
    }
  });
  const configured = (id: Source): boolean =>
    configuration()?.sources.some((entry) => entry.id === id && entry.configured) === true;
  const available = (): boolean => sources.some((entry) => configured(entry.id));
  const cancel = (): void => {
    scope.invalidate();
    setBusy(null);
  };
  document.body.classList.add("consumer-ready", "furu-ready");
  preparePage();
  onCleanup(() => {
    cancel();
    configurationController.abort();
    document.body.classList.remove("consumer-ready", "furu-ready");
  });
  createEffect(() => {
    const listings = [
      ...entries().flatMap((entry) => entry.data?.listings ?? []),
      ...selected().map((entry) => entry.listing),
      ...(result()?.listings ?? []),
    ];
    if (listings.length === 0) {
      return;
    }
    const remaining = expiryDelay(listings);
    const timer = setTimeout(
      () => {
        cancel();
        batch(() => {
          setEntries([]);
          setSelected([]);
          setResult(undefined);
          setActiveSearch(undefined);
          setError("表示期限が切れました。もう一度検索してください");
        });
      },
      Math.max(0, remaining),
    );
    onCleanup(() => {
      clearTimeout(timer);
    });
  });
  const search = async (text = query(), nextPage = 1, nextSource = source()): Promise<void> => {
    if (text.trim().length === 0) {
      setError("返礼品名を入力してください");
      return;
    }
    if (new TextEncoder().encode(text.trim()).length > 128) {
      setError("検索語を短くしてください");
      return;
    }
    cancel();
    const request = scope.begin();
    batch(() => {
      setQuery(text);
      setError("");
      setBusy("search");
      setResult(undefined);
      setEntries([]);
      setActiveSearch({ query: text.trim(), source: nextSource, page: nextPage });
    });
    const requested = sources.filter(
      (entry) => configured(entry.id) && (nextSource === "all" || entry.id === nextSource),
    );
    try {
      await Promise.all(
        requested.map(async (entry) => {
          let response: Entry;
          try {
            response = {
              source: entry.id,
              data: await fetchCommerceListings(
                {
                  source: entry.id,
                  operation: "search",
                  query: text.trim(),
                  page: nextPage,
                  limit: 10,
                },
                { signal: request.signal },
              ),
              error: null,
            };
          } catch (failure: unknown) {
            response = { source: entry.id, data: null, error: errorMessage(failure) };
          }
          if (request.isCurrent()) {
            setEntries((previous) => [...previous, response]);
          }
        }),
      );
    } finally {
      if (request.isCurrent()) {
        setBusy(null);
      }
    }
  };
  const startSearch = (text?: string): void => {
    search(text).catch(() => {
      setBusy(null);
      setError("検索できませんでした。再試行してください");
    });
  };
  const compare = async (): Promise<void> => {
    const choices = selected();
    if (choices.length < 2 || choices.length > 6) {
      return;
    }
    cancel();
    const request = scope.begin();
    batch(() => {
      setError("");
      setBusy("compare");
      setResult(undefined);
    });
    try {
      const data = await fetchFurusatoComparison(
        {
          items: choices.map((entry) => ({
            source: entry.source,
            query: entry.source === "satofull" ? entry.listing.id : entry.listing.url,
          })),
        },
        { signal: request.signal },
      );
      if (!request.isCurrent()) {
        return;
      }
      batch(() => {
        setResult(data);
        setSelected(
          data.listings.flatMap((listing) =>
            listing.source === "satofull" || listing.source === "rakuten_furusato"
              ? [{ source: listing.source, listing }]
              : [],
          ),
        );
      });
      document.getElementById("furu-result-heading")?.focus();
      document.getElementById("furu-result-heading")?.scrollIntoView({ block: "start" });
    } catch (failure: unknown) {
      if (request.isCurrent()) {
        setError(errorMessage(failure));
      }
    } finally {
      if (request.isCurrent()) {
        setBusy(null);
      }
    }
  };
  const toggle = (listing: CommerceListing): void => {
    if (busy() === "compare") {
      return;
    }
    if (selected().some((entry) => key(entry.listing) === key(listing))) {
      setSelected((previous) => previous.filter((entry) => key(entry.listing) !== key(listing)));
    } else if (
      selected().length < 6 &&
      (listing.source === "satofull" || listing.source === "rakuten_furusato")
    ) {
      const selection: Selection = { listing, source: listing.source };
      setSelected((previous) => [...previous, selection]);
    }
  };
  const cards = () => {
    const listings = sources.flatMap(
      (entry) => entries().find((value) => value.source === entry.id)?.data?.listings ?? [],
    );
    return sort() === "amount"
      ? listings.toSorted(
          (a, b) => (a.amount?.minimum ?? Infinity) - (b.amount?.minimum ?? Infinity),
        )
      : listings;
  };
  const itemFor = (listing: CommerceListing): Item | undefined =>
    entries()
      .find((entry) => entry.source === listing.source)
      ?.data?.furusato?.items.find((item) => item.id === listing.id);
  const hasNext = (): boolean =>
    entries().some(
      (entry) =>
        entry.data !== null &&
        (entry.data.total === null
          ? entry.data.listings.length === 10
          : entry.data.page * entry.data.limit < entry.data.total),
    );
  return (
    <>
      <ServiceHeader current="furusato" />
      <main
        class="furu-main"
        classList={{ "furu-has-selection": selected().length > 0 && result() === undefined }}
      >
        <div class="furu-title">
          <div>
            <p>楽天ふるさと納税 × さとふる</p>
            <h1>返礼品を比べる</h1>
          </div>
          <Show when={result()}>
            <button
              class="secondary-button"
              type="button"
              onClick={() => {
                setResult(undefined);
              }}
            >
              返礼品を選び直す
            </button>
          </Show>
        </div>
        <Show when={result() === undefined}>
          <form
            class="furu-search-panel"
            onSubmit={(event) => {
              event.preventDefault();
              startSearch();
            }}
          >
            <label for="furu-query">返礼品を探す</label>
            <div class="search">
              <div class="url-input-wrap">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="6" stroke="currentColor" stroke-width="1.8" />
                  <path
                    d="m15 15 5 5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
                <input
                  id="furu-query"
                  type="search"
                  required
                  maxLength={128}
                  placeholder="米、牛肉、ホタテなど"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </div>
              <button
                class="primary-button"
                type="submit"
                disabled={busy() !== null || !available()}
              >
                検索する
              </button>
            </div>
            <div class="furu-search-options">
              <div class="furu-category-chips" role="group" aria-label="返礼品カテゴリ">
                <For each={Object.values(categories)}>
                  {(label) => (
                    <button
                      type="button"
                      disabled={busy() !== null || !available()}
                      onClick={() => {
                        startSearch(label);
                      }}
                    >
                      {label}
                    </button>
                  )}
                </For>
              </div>
              <label class="furu-source-select">
                寄付サイト
                <select
                  value={source()}
                  disabled={busy() !== null}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "all" || value === "satofull" || value === "rakuten_furusato") {
                      setSource(value);
                    }
                  }}
                >
                  <option value="all">両方のサイト</option>
                  <For each={sources}>
                    {(entry) => (
                      <option value={entry.id} disabled={!configured(entry.id)}>
                        {entry.label}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </div>
          </form>
          <Show when={configuration.loading}>
            <p class="furu-state" role="status">
              接続中…
            </p>
          </Show>
          <Show when={configuration()?.error === true}>
            <div class="furu-state" role="alert">
              比較サービスに接続できません{" "}
              <button
                class="text-button"
                type="button"
                onClick={() => {
                  Promise.resolve(refetch()).catch(() => setError("接続できませんでした"));
                }}
              >
                再接続
              </button>
            </div>
          </Show>
          <Show when={configuration()?.error === false && !available()}>
            <p class="furu-state" role="status">
              返礼品の検索は準備中です
            </p>
          </Show>
          <Show when={available()}>
            <For each={sources.filter((entry) => !configured(entry.id))}>
              {(entry) => <p class="furu-state">{entry.label}は現在利用できません</p>}
            </For>
          </Show>
          <Show when={activeSearch()}>
            {(active) => (
              <section aria-labelledby="furu-search-heading">
                <div class="furu-section-heading">
                  <h2 id="furu-search-heading">
                    「{active().query}」の返礼品 <span>{cards().length}件</span>
                  </h2>
                  <label class="furu-sort">
                    <span class="sr-only">表示順</span>
                    <select value={sort()} onChange={(event) => setSort(event.currentTarget.value)}>
                      <option value="original">サイト掲載順</option>
                      <option value="amount">寄付額が低い順</option>
                    </select>
                  </label>
                </div>
                <For each={entries().filter((entry) => entry.error !== null)}>
                  {(entry) => (
                    <p class="status error" role="alert">
                      {sourceLabel(entry.source)}：{entry.error}
                      <button
                        class="text-button"
                        type="button"
                        disabled={busy() !== null}
                        onClick={() => {
                          search(active().query, active().page, active().source).catch(() =>
                            setError("再検索できませんでした"),
                          );
                        }}
                      >
                        再試行
                      </button>
                    </p>
                  )}
                </For>
                <div class="furu-grid">
                  <For each={cards()}>
                    {(listing) => {
                      const chosen = () =>
                        selected().some((entry) => key(entry.listing) === key(listing));
                      return (
                        <article class="furu-card" classList={{ "furu-card-selected": chosen() }}>
                          <div class="furu-card-meta">
                            <span class={`furu-source furu-source-${listing.source}`}>
                              {sourceLabel(listing.source)}
                            </span>
                            <Show
                              when={field(itemFor(listing), "deliveryMode")?.status === "known"}
                            >
                              <span class="furu-delivery">
                                {fieldValue(field(itemFor(listing), "deliveryMode"))}
                              </span>
                            </Show>
                          </div>
                          <ProductImage listing={listing} />
                          <h3>{listing.title}</h3>
                          <Show when={field(itemFor(listing), "municipality")?.status === "known"}>
                            <p class="furu-card-municipality">
                              {fieldValue(field(itemFor(listing), "municipality"))}
                            </p>
                          </Show>
                          <div class="furu-card-facts">
                            <strong>{amount(listing)}</strong>
                            <span>{fieldValue(field(itemFor(listing), "totalGrams"))}</span>
                          </div>
                          <div class="furu-card-actions">
                            <button
                              type="button"
                              class="furu-select-button"
                              aria-pressed={chosen()}
                              disabled={
                                listing.availability === "unavailable" ||
                                (!chosen() && selected().length >= 6)
                              }
                              onClick={() => {
                                toggle(listing);
                              }}
                            >
                              {listing.availability === "unavailable"
                                ? "受付終了"
                                : chosen()
                                  ? "✓ 選択中"
                                  : "＋ 比較に追加"}
                            </button>
                            <a
                              href={listing.affiliateUrl}
                              target="_blank"
                              rel="sponsored noopener noreferrer"
                              aria-label={`${listing.title}を寄付サイトで見る（広告）`}
                            >
                              詳細 <span aria-hidden="true">↗</span>
                            </a>
                          </div>
                        </article>
                      );
                    }}
                  </For>
                </div>
                <Show
                  when={
                    busy() === null &&
                    entries().length > 0 &&
                    entries().every((entry) => entry.error === null) &&
                    cards().length === 0
                  }
                >
                  <p class="furu-state">該当する返礼品がありません</p>
                </Show>
                <Show when={busy() === null && entries().length > 0}>
                  <div class="furu-pagination">
                    <button
                      class="secondary-button"
                      type="button"
                      disabled={active().page <= 1}
                      onClick={() => {
                        search(active().query, active().page - 1, active().source).catch(() =>
                          setError("取得できませんでした"),
                        );
                      }}
                    >
                      前へ
                    </button>
                    <span>{active().page}ページ</span>
                    <button
                      class="secondary-button"
                      type="button"
                      disabled={!hasNext() || active().page >= 10}
                      onClick={() => {
                        search(active().query, active().page + 1, active().source).catch(() =>
                          setError("取得できませんでした"),
                        );
                      }}
                    >
                      次へ
                    </button>
                  </div>
                </Show>
              </section>
            )}
          </Show>
        </Show>
        <Show when={error().length > 0}>
          <p class="status error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={busy() !== null}>
          <div class="furu-loading" role="status">
            <span class="consumer-spinner" />
            <span>{busy() === "search" ? "返礼品を検索中…" : "比較情報を取得中…"}</span>
            <button type="button" class="text-button" onClick={cancel}>
              中止
            </button>
          </div>
        </Show>
        <Show when={result()}>{(data) => <ComparisonTable data={data()} />}</Show>
        <p class="furu-ad-notice">寄付サイトへのリンクには広告を含みます。</p>
      </main>
      <Show when={selected().length > 0 && result() === undefined}>
        <aside class="furu-tray" aria-label="比較する返礼品">
          <div class="furu-tray-inner">
            <div class="furu-tray-summary">
              <strong aria-live="polite">
                選択中 <span>{selected().length} / 6</span>
              </strong>
              <button
                class="text-button"
                type="button"
                disabled={busy() === "compare"}
                onClick={() => setSelected([])}
              >
                すべて解除
              </button>
            </div>
            <div class="furu-selected-list">
              <For each={selected()}>
                {(entry, index) => (
                  <button
                    class="furu-selected-chip"
                    type="button"
                    disabled={busy() === "compare"}
                    onClick={() => {
                      toggle(entry.listing);
                    }}
                    aria-label={`${entry.listing.title}を比較から外す`}
                  >
                    <span>
                      {index() + 1}. {entry.listing.title}
                    </span>
                    <b aria-hidden="true">×</b>
                  </button>
                )}
              </For>
            </div>
            <button
              class="primary-button furu-compare"
              type="button"
              disabled={selected().length < 2 || busy() !== null}
              onClick={() => {
                compare().catch(() => {
                  setBusy(null);
                  setError("比較できませんでした");
                });
              }}
            >
              {busy() === "compare"
                ? "比較中…"
                : selected().length < 2
                  ? "2件以上で比較"
                  : `${selected().length}件を比較する`}
            </button>
          </div>
        </aside>
      </Show>
    </>
  );
}
