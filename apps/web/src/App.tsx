/** @jsxImportSource solid-js */
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  compareChargers,
  compareMonitors,
  compareProducts,
  investigateProduct,
  parseChargerUse,
} from "@app/api-client";
import type {
  ChargerComparison,
  ChargerUse,
  Investigation,
  MonitorComparison,
  MonitorConditions,
  MonitorSpecifications,
  ProductComparison,
} from "@app/api-client";

import { ConsumerApp } from "./ConsumerApp.js";
import { FurusatoApp } from "./FurusatoApp.js";
import { SecuritiesApp } from "./SecuritiesApp.js";

type ComparisonMode = "price" | "performance" | "ai";
type ViewResult<T> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "err"; message: string }>;
type LiveProduct = Extract<Investigation, { mode: "live" }>;
type ProductColumn = Readonly<{
  id: string;
  title: string;
  imageUrl: string | null;
  isSource: boolean;
  rank: number | null;
  recommendationPercent: number | null;
  specifications: LiveProduct["specifications"];
  monitorSpecifications?: MonitorSpecifications;
  price: LiveProduct["price"] | null;
  tax: LiveProduct["tax"] | null;
  href: string | null;
  sponsored: boolean;
  state: string;
  reasons: readonly string[];
  axes: ReadonlyArray<Readonly<{ id: string; label: string; score: number | null }>>;
}>;

const pages = [
  { id: "price", path: "/compare/price/", label: "価格比較", title: "類似商品の価格比較" },
  {
    id: "performance",
    path: "/compare/performance/",
    label: "性能比較",
    title: "類似商品の性能比較",
  },
  { id: "ai", path: "/compare/ai/", label: "AI比較", title: "類似商品のおすすめ比較" },
] satisfies ReadonlyArray<
  Readonly<{ id: ComparisonMode; path: string; label: string; title: string }>
>;
const axisLabels: Readonly<Record<string, string>> = {
  price: "価格",
  power: "出力",
  portability: "携帯性",
  warranty: "保証",
  port_operation: "ポート表示",
  plug_storage: "プラグ形状",
};
const comparisonReasons: Readonly<Record<string, string>> = {
  ac_input: "日本の電源条件に非対応",
  cable_capacity: "ケーブル能力が不足",
  output_configuration: "指定した動作点で同時供給できない",
  cable_unknown: "ケーブル能力が未確認",
  incomplete_configurations: "同時出力の仕様が不足",
  stale_specification: "仕様の確認期限切れ",
  source_not_authorized: "仕様の利用期限切れ",
  required_printedPortMarking: "必須のポート表示と不一致",
  required_plugDesign: "必須のプラグ形状と不一致",
  unverified_printedPortMarking: "ポート表示が未確認",
  unverified_plugDesign: "プラグ形状が未確認",
};
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });

function currentMode(): ComparisonMode {
  return pages.find((page) => page.path === window.location.pathname)?.id ?? "ai";
}

function updatePageTitle(mode: ComparisonMode): void {
  document.title = `${pages.find((page) => page.id === mode)?.label ?? "商品比較"} | 商品比較`;
}

function expireAt(expiresAt: string, expire: () => void): () => void {
  const remaining = Date.parse(expiresAt) - Date.now();
  const timer = setTimeout(expire, Math.max(0, Math.min(remaining, 900_000)));
  return () => {
    clearTimeout(timer);
  };
}

function valueWithUnit(value: number | null, unit: string): string {
  return value === null ? "未確認" : `${value}${unit}`;
}

function ProductTable(
  props: Readonly<{ products: readonly ProductColumn[]; scoreLabel?: string; monitor?: boolean }>,
): JSX.Element {
  const chargerRows = [
    {
      label: "掲載価格",
      value: (product: ProductColumn): string =>
        product.price === null
          ? "未確認"
          : `${yen.format(product.price.minimum)}${product.price.maximum === product.price.minimum ? "" : `〜${yen.format(product.price.maximum)}`}${product.tax === "included" ? "（税込）" : "（税別）"}`,
    },
    {
      label: "最大出力",
      value: (product: ProductColumn): string =>
        valueWithUnit(product.specifications.maxPowerW, "W"),
    },
    {
      label: "ポート",
      value: (product: ProductColumn): string => {
        const { usbCPorts, usbAPorts } = product.specifications;
        if (usbCPorts === null && usbAPorts === null) {
          return "未確認";
        }
        return [
          usbCPorts === null ? "USB-C 未確認" : usbCPorts === 0 ? "" : `USB-C × ${usbCPorts}`,
          usbAPorts === null ? "USB-A 未確認" : usbAPorts === 0 ? "" : `USB-A × ${usbAPorts}`,
        ]
          .filter((port) => port.length > 0)
          .join(" / ");
      },
    },
    {
      label: "重さ",
      value: (product: ProductColumn): string => valueWithUnit(product.specifications.weightG, "g"),
    },
    {
      label: "保証",
      value: (product: ProductColumn): string =>
        valueWithUnit(product.specifications.warrantyMonths, "か月"),
    },
  ];
  const rows = () =>
    props.monitor === true
      ? [
          chargerRows[0],
          {
            label: "画面サイズ",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.screenSizeInches ?? null, "型"),
          },
          {
            label: "解像度",
            value: (product: ProductColumn): string => {
              const width = product.monitorSpecifications?.resolutionWidthPx ?? null;
              const height = product.monitorSpecifications?.resolutionHeightPx ?? null;
              return width === null || height === null ? "未確認" : `${width} × ${height}`;
            },
          },
          {
            label: "リフレッシュレート",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.refreshRateHz ?? null, "Hz"),
          },
          {
            label: "USB-C 映像入力",
            value: (product: ProductColumn): string =>
              product.monitorSpecifications?.usbCVideo === undefined ||
              product.monitorSpecifications.usbCVideo === null
                ? "未確認"
                : product.monitorSpecifications.usbCVideo
                  ? "対応"
                  : "非対応",
          },
          {
            label: "USB-C 給電",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.usbCPowerW ?? null, "W"),
          },
          {
            label: "HDMI 入力",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.hdmiPorts ?? null, "端子"),
          },
          {
            label: "DisplayPort 入力",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.displayPortPorts ?? null, "端子"),
          },
          {
            label: "高さ調整",
            value: (product: ProductColumn): string =>
              product.monitorSpecifications?.heightAdjustable === undefined ||
              product.monitorSpecifications.heightAdjustable === null
                ? "未確認"
                : product.monitorSpecifications.heightAdjustable
                  ? "対応"
                  : "非対応",
          },
          {
            label: "保証",
            value: (product: ProductColumn): string =>
              valueWithUnit(product.monitorSpecifications?.warrantyMonths ?? null, "か月"),
          },
          { label: "条件への適合", value: (product: ProductColumn): string => product.state },
        ].filter((row) => row !== undefined)
      : chargerRows;
  return (
    <div
      class="table-wrap"
      tabindex="0"
      role="region"
      aria-label="商品比較表（横にスクロールできます）"
    >
      <table
        class="comparison-table"
        style={{ "--product-count": String(Math.max(props.products.length, 1)) }}
      >
        <caption class="sr-only">類似商品の仕様と評価の比較</caption>
        <thead>
          <tr>
            <th class="row-label product-label" scope="col">
              比較商品
            </th>
            <For
              each={props.products}
              fallback={
                <th class="empty" scope="col">
                  比較結果はここに表示されます
                </th>
              }
            >
              {(product) => (
                <th
                  classList={{ "product-heading": true, "best-product": product.rank === 1 }}
                  scope="col"
                >
                  <div class="rank-line">
                    <Show
                      when={product.rank ?? undefined}
                      fallback={<span class="pending-rank">{product.state}</span>}
                    >
                      {(rank) => (
                        <>
                          <span class={`medal medal-${rank() <= 3 ? rank() : "other"}`}>
                            {rank()}
                          </span>
                          <span>
                            {props.products.filter((other) => other.rank === rank()).length > 1
                              ? "同率"
                              : ""}
                            {rank()}位
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={product.isSource}>
                      <span class="source-tag">入力商品</span>
                    </Show>
                  </div>
                  <div
                    classList={{ "product-image": true, "no-image": product.imageUrl === null }}
                    role="img"
                    aria-label={
                      product.imageUrl === null
                        ? `${product.title}：画像未取得`
                        : `${product.title}の商品画像`
                    }
                    style={
                      product.imageUrl === null
                        ? {}
                        : { "background-image": `url(${JSON.stringify(product.imageUrl)})` }
                    }
                  >
                    <Show when={product.imageUrl === null}>
                      <span>画像未取得</span>
                    </Show>
                  </div>
                  <h3 title={product.title}>{product.title}</h3>
                  <Show
                    when={
                      product.specifications.brand !== null &&
                      !product.title
                        .toLowerCase()
                        .includes(product.specifications.brand.toLowerCase())
                    }
                  >
                    <span class="product-brand">{product.specifications.brand}</span>
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show when={props.monitor !== true}>
            <tr class="recommendation-row">
              <th class="row-label" scope="row">
                {props.scoreLabel ?? "おすすめ度"}
                <small>比較スコア / 100</small>
              </th>
              <For each={props.products}>
                {(product) => (
                  <td classList={{ "best-product": product.rank === 1 }}>
                    <Show
                      when={
                        product.recommendationPercent === null
                          ? undefined
                          : { value: product.recommendationPercent }
                      }
                      fallback={<span class="unknown">未判定</span>}
                    >
                      {(score) => (
                        <>
                          <strong class="recommendation-value">{score().value}%</strong>
                          <progress
                            max="100"
                            value={score().value}
                            aria-label={`${product.title}の比較スコア`}
                          />
                        </>
                      )}
                    </Show>
                  </td>
                )}
              </For>
            </tr>
          </Show>
          <For each={rows()}>
            {(row) => (
              <tr>
                <th class="row-label" scope="row">
                  {row.label}
                </th>
                <For each={props.products}>
                  {(product) => (
                    <td
                      classList={{
                        "best-product": product.rank === 1,
                        unknown: row.value(product) === "未確認",
                      }}
                    >
                      {row.value(product)}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
          <Show when={props.monitor !== true}>
            <tr class="criteria-row">
              <th class="row-label" scope="row">
                評価の内訳<small>評価基準は下部に表示</small>
              </th>
              <For each={props.products}>
                {(product) => (
                  <td classList={{ "best-product": product.rank === 1 }}>
                    <div class="criteria-chart">
                      <For each={product.axes} fallback={<span class="unknown">評価項目なし</span>}>
                        {(axis) => (
                          <div class={`criterion criterion-${axis.id}`}>
                            <span>{axis.label}</span>
                            <Show
                              when={axis.score === null ? undefined : { value: axis.score }}
                              fallback={
                                <>
                                  <span class="empty-track" />
                                  <span class="unknown">—</span>
                                </>
                              }
                            >
                              {(score) => (
                                <>
                                  <progress
                                    max="100"
                                    value={score().value}
                                    aria-label={`${product.title}：${axis.label} ${score().value}点`}
                                  />
                                  <span>{score().value}</span>
                                </>
                              )}
                            </Show>
                          </div>
                        )}
                      </For>
                      <div class="chart-scale">
                        <span>0</span>
                        <span>100</span>
                      </div>
                    </div>
                  </td>
                )}
              </For>
            </tr>
          </Show>
          <tr class="purchase-row">
            <th class="row-label" scope="row">
              商品ページ<small>楽天リンクは広告</small>
            </th>
            <For each={props.products}>
              {(product) => (
                <td classList={{ "best-product": product.rank === 1 }}>
                  <Show
                    when={product.href ?? undefined}
                    fallback={<span class="unknown">リンク未取得</span>}
                  >
                    {(href) => (
                      <a
                        class="purchase-button"
                        href={href()}
                        target="_blank"
                        rel={
                          product.sponsored
                            ? "sponsored noopener noreferrer"
                            : "noopener noreferrer"
                        }
                      >
                        {product.sponsored ? "商品を見る" : "公式仕様を見る"}
                        <span aria-hidden="true"> ↗</span>
                      </a>
                    )}
                  </Show>
                </td>
              )}
            </For>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function LiveResults(props: Readonly<{ data: ProductComparison }>): JSX.Element {
  const [expired, setExpired] = createSignal(false);
  createEffect(() => {
    setExpired(false);
    const expiry = [
      props.data.source.expiresAt,
      ...props.data.products.map((product) => product.expiresAt),
    ].toSorted((left, right) => left.localeCompare(right))[0];
    if (expiry !== undefined) {
      onCleanup(expireAt(expiry, () => setExpired(true)));
    }
  });
  const products = (): readonly ProductColumn[] =>
    props.data.products.map((product) => ({
      id: product.listingId,
      title: product.title,
      imageUrl: product.imageUrl,
      isSource: false,
      rank: product.rank,
      recommendationPercent: product.recommendationPercent,
      specifications: product.specifications,
      price: product.price,
      tax: product.tax,
      href: product.affiliateUrl,
      sponsored: true,
      state: "判定保留",
      reasons: product.reasons,
      axes: product.axes.map((axis) => ({
        id: axis.id,
        label: axisLabels[axis.id] ?? axis.id,
        score: axis.score,
      })),
    }));
  return (
    <Show
      when={!expired()}
      fallback={
        <p class="status" role="status">
          表示期限が切れました。「比較する」で再取得してください。
        </p>
      }
    >
      <Show when={props.data.products.length > 0}>
        <ProductTable
          products={products()}
          scoreLabel={
            props.data.comparisonMode === "price"
              ? "価格スコア"
              : props.data.comparisonMode === "performance"
                ? "出力スコア"
                : "おすすめ度"
          }
        />
      </Show>
      <div class="result-footer">
        <span>{props.data.products.length}商品 · 送料別の価格は送料を含みません</span>
        <span>確認 {new Date(props.data.source.observedAt).toLocaleString("ja-JP")}</span>
      </div>
      <Show when={props.data.products.length === 0}>
        <p class="status" role="status">
          比較できる類似商品が見つかりませんでした。条件を変えて再取得してください。
        </p>
      </Show>
      <Show when={props.data.status === "needs_information"}>
        <p class="result-notice" role="status">
          比較に必要な情報が不足しています。未確認の項目を使った順位・おすすめ度は表示しません。
        </p>
      </Show>
      <details class="details evidence">
        <summary>評価基準・出典</summary>
        <p>
          {props.data.comparisonMode === "price"
            ? "価格スコアは、比較候補の最安の税込掲載価格 ÷ その商品の税込掲載価格 × 100です。送料は比較に含みません。"
            : props.data.comparisonMode === "performance"
              ? "出力スコアは、その商品の最大出力 ÷ 比較候補の最大出力 × 100です。最大出力だけで総合性能や同時充電の適合は判断しません。"
              : "おすすめ度は、比較候補の価格・最大出力・重さ・保証を各25％で評価した比較スコアです。価格と重さは候補の最小値 ÷ 商品の値、出力と保証は商品の値 ÷ 候補の最大値で計算します。"}
          各スコアは100点満点で丸めた値です。購買確率やJevによる評価ではありません。欠損値は推測で埋めません。
        </p>
        <p>検索語：{props.data.keyword}</p>
        <p>
          入力商品：
          <a href={props.data.source.canonicalUrl} target="_blank" rel="noopener noreferrer">
            {props.data.source.title}
          </a>
        </p>
        <For each={props.data.products}>
          {(product) => (
            <div class="evidence-product">
              <a href={product.canonicalUrl} target="_blank" rel="noopener noreferrer">
                {product.title}
              </a>
              <span>
                {product.shopName} ·{" "}
                {product.shipping === "included" ? "API上は送料込み" : "送料別・金額未確認"}
              </span>
              <For each={product.reasons}>
                {(reason) => <span>{comparisonReasons[reason] ?? reason}</span>}
              </For>
            </div>
          )}
        </For>
      </details>
    </Show>
  );
}

function ChargerResults(props: Readonly<{ data: ChargerComparison }>): JSX.Element {
  const [expired, setExpired] = createSignal(false);
  createEffect(() => {
    setExpired(false);
    const data = props.data;
    if (data.mode !== "live") {
      onCleanup(expireAt(data.expiresAt, () => setExpired(true)));
    }
  });
  const products = (): readonly ProductColumn[] => {
    const data = props.data;
    if (data.mode === "live") {
      return [];
    }
    return data.products.map((product) => ({
      id: product.productId,
      title: product.title,
      imageUrl: null,
      isSource: product.isSource,
      rank: product.rank,
      recommendationPercent: null,
      specifications: {
        model: product.productId,
        brand: product.official === null ? null : "ELECOM",
        gtin: product.official?.gtin ?? null,
        color: product.official?.color ?? null,
        maxPowerW: product.official?.maxPowerW ?? null,
        usbCPorts: product.official?.portCount ?? null,
        usbAPorts: product.official === null ? null : 0,
        weightG: product.official?.weightG ?? null,
        warrantyMonths: null,
      },
      price: null,
      tax: null,
      href: product.official?.canonicalUrl ?? null,
      sponsored: false,
      state:
        product.status === "excluded"
          ? "条件不適合"
          : product.status === "pending"
            ? "判定保留"
            : "順位なし",
      reasons: product.reasons,
      axes: product.axes.map((axis) => ({
        id: axis.id,
        label: axisLabels[axis.id] ?? axis.id,
        score: axis.level * 50,
      })),
    }));
  };
  return (
    <Show
      when={!expired()}
      fallback={
        <p class="status" role="status">
          比較結果の表示期限が切れました。再取得してください。
        </p>
      }
    >
      <ProductTable products={products()} />
      <p class="result-notice" role="status">
        指定した充電条件と希望への適合比較です。価格・総合性能の順位やおすすめ％は未判定です。
      </p>
      <details class="details evidence">
        <summary>適合条件・出典</summary>
        <Show when={props.data.mode !== "live" ? props.data : undefined}>
          {(data) => (
            <>
              <p>{data().notice}</p>
              <p>
                選択した希望を同じ重みで判定。各項目は「希望を満たす」100、「一部満たす」50、「希望と異なる」0です。同点は同順位です。
              </p>
              <For each={data().products}>
                {(product) => (
                  <div class="evidence-product">
                    <strong>{product.title}</strong>
                    <For each={product.reasons}>
                      {(reason) => <span>{comparisonReasons[reason] ?? reason}</span>}
                    </For>
                    <For each={product.axes}>
                      {(axis) => (
                        <a href={axis.source} target="_blank" rel="noopener noreferrer">
                          {axisLabels[axis.id]}の出典
                        </a>
                      )}
                    </For>
                    <Show when={product.official}>
                      {(official) => (
                        <a href={official().canonicalUrl} target="_blank" rel="noopener noreferrer">
                          公式仕様・型番
                        </a>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </>
          )}
        </Show>
      </details>
    </Show>
  );
}

function ChargerConditions(
  props: Readonly<{
    source: Investigation;
    disabled: boolean;
    onChange: () => void;
    onCompare: (conditions: ChargerUse, notes: string) => void;
  }>,
): JSX.Element {
  const [deviceCount, setDeviceCount] = createSignal("1");
  const [preset, setPreset] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);
  const [formError, setFormError] = createSignal("");
  const reset = (): void => {
    setConfirmed(false);
    setFormError("");
    props.onChange();
  };
  return (
    <details class="details compatibility" open={props.source.mode !== "live"}>
      <summary>充電条件の適合を確認</summary>
      <form
        class="conditions"
        onInput={(event) => {
          if (event.target instanceof HTMLElement && event.target.id !== "confirmed") {
            reset();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed() || props.disabled) {
            return;
          }
          try {
            const data = new FormData(event.currentTarget);
            const number = (name: string): number => {
              const value = data.get(name);
              return typeof value === "string" && value.trim().length > 0
                ? Number(value)
                : Number.NaN;
            };
            const use = parseChargerUse({
              devices: Array.from({ length: Number(deviceCount()) }, (_, index) => ({
                id: `device-${index + 1}`,
                protocol: data.get(`protocol-${index}`),
                voltageV: number(`voltage-${index}`),
                currentA: number(`current-${index}`),
                cable:
                  data.get(`cable-current-${index}`) === "unknown" ||
                  data.get(`cable-voltage-${index}`) === "unknown"
                    ? null
                    : {
                        maxCurrentA: number(`cable-current-${index}`),
                        maxVoltageV: number(`cable-voltage-${index}`),
                      },
              })),
              portPreference: data.get("port-preference"),
              plugPreference: data.get("plug-preference"),
            });
            setFormError("");
            props.onCompare(use, "");
          } catch (error: unknown) {
            setFormError(error instanceof Error ? error.message : "条件を確認してください");
          }
        }}
      >
        <p>
          日本のAC100V・50/60Hzで使用。端末の必要な動作点とケーブル能力を仕様書で確認してください。
        </p>
        <Show when={props.source.mode === "demo"}>
          <button
            class="secondary-button"
            type="button"
            onClick={(event) => {
              setPreset(false);
              setDeviceCount("1");
              event.currentTarget.form?.reset();
              setDeviceCount("2");
              setPreset(true);
              reset();
            }}
          >
            デモの2台同時充電条件を入力
          </button>
        </Show>
        <label class="field device-count">
          同時に充電する台数
          <select
            value={deviceCount()}
            onChange={(event) => {
              setDeviceCount(event.currentTarget.value);
              reset();
            }}
          >
            <option value="1">1台</option>
            <option value="2">2台</option>
            <option value="3">3台</option>
            <option value="4">4台</option>
          </select>
        </label>
        <For each={Array.from({ length: Number(deviceCount()) }, (_, index) => index)}>
          {(index) => (
            <fieldset>
              <legend>端末 {index + 1}</legend>
              <div class="condition-grid">
                <label class="field">
                  充電方式
                  <select name={`protocol-${index}`} value="pd">
                    <option value="pd">USB PD（固定電圧）</option>
                    <option value="pps">PPS</option>
                  </select>
                </label>
                <label class="field">
                  必要な電圧（V）
                  <input
                    name={`voltage-${index}`}
                    type="number"
                    min="0.1"
                    max="48"
                    step="any"
                    required
                    value={preset() ? (index === 0 ? "20" : "5") : ""}
                  />
                </label>
                <label class="field">
                  必要な電流（A）
                  <input
                    name={`current-${index}`}
                    type="number"
                    min="0.01"
                    max="5"
                    step="any"
                    required
                    value={preset() ? (index === 0 ? "3.25" : "3") : ""}
                  />
                </label>
                <label class="field">
                  ケーブル最大電流
                  <select
                    name={`cable-current-${index}`}
                    value={preset() ? (index === 0 ? "5" : "3") : "unknown"}
                  >
                    <option value="unknown">未確認（判定保留）</option>
                    <option value="3">3A</option>
                    <option value="5">5A（eMarker確認済み）</option>
                  </select>
                </label>
                <label class="field">
                  ケーブル最大電圧
                  <select name={`cable-voltage-${index}`} value={preset() ? "20" : "unknown"}>
                    <option value="unknown">未確認（判定保留）</option>
                    <option value="20">20V</option>
                    <option value="48">48V（EPR対応確認済み）</option>
                  </select>
                </label>
              </div>
            </fieldset>
          )}
        </For>
        <div class="condition-grid preferences">
          <label class="field">
            ポート表示
            <select name="port-preference" value={preset() ? "prefer_roles" : "ignore"}>
              <option value="ignore">評価しない</option>
              <option value="prefer_roles">端末名表示を希望</option>
              <option value="require_roles">端末名表示が必須</option>
              <option value="prefer_numbers">番号表示を希望</option>
              <option value="require_numbers">番号表示が必須</option>
            </select>
          </label>
          <label class="field">
            プラグ形状
            <select name="plug-preference" value={preset() ? "prefer_folding" : "ignore"}>
              <option value="ignore">評価しない</option>
              <option value="prefer_folding">折り畳みを希望</option>
              <option value="require_folding">折り畳みが必須</option>
              <option value="prefer_fixed">固定を希望</option>
              <option value="require_fixed">固定が必須</option>
            </select>
          </label>
        </div>
        <label class="confirm">
          <input
            id="confirmed"
            type="checkbox"
            checked={confirmed()}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            required
          />
          端末・ケーブル能力と希望／必須条件を確認した
        </label>
        <Show when={formError().length > 0}>
          <p class="error" role="alert">
            {formError()}
          </p>
        </Show>
        <button class="primary-button" type="submit" disabled={!confirmed() || props.disabled}>
          充電条件で比較
        </button>
      </form>
    </details>
  );
}

const monitorReasons: Readonly<Record<string, string>> = {
  unavailable: "購入できない掲載",
  identity_unknown: "型番・JANコードの同定が未確認",
  screen_size: "画面サイズが対象・指定条件と不一致",
  screen_size_unknown: "画面サイズが未確認",
  resolution_width: "解像度が指定条件に不足",
  resolution_height: "解像度が指定条件に不足",
  resolution_width_unknown: "解像度が未確認",
  resolution_height_unknown: "解像度が未確認",
  usb_c_video: "USB-C映像入力に非対応",
  usb_c_video_unknown: "USB-C映像入力が未確認",
  usb_c_power: "USB-C給電が指定条件に不足",
  usb_c_power_unknown: "USB-C給電が未確認",
  height_adjustment: "高さ調整に非対応",
  height_adjustment_unknown: "高さ調整が未確認",
};

function MonitorResults(props: Readonly<{ data: MonitorComparison }>): JSX.Element {
  const [expired, setExpired] = createSignal(false);
  createEffect(() => {
    setExpired(false);
    const expiry = props.data.products
      .map((product) => product.expiresAt)
      .toSorted((left, right) => left.localeCompare(right))[0];
    if (expiry !== undefined) {
      onCleanup(expireAt(expiry, () => setExpired(true)));
    }
  });
  const products = (): readonly ProductColumn[] =>
    props.data.products.map((product) => ({
      id: product.listingId,
      title: product.title,
      imageUrl: product.imageUrl,
      isSource: product.listingId === props.data.source.listingId,
      rank: product.rank,
      recommendationPercent: null,
      specifications: product.specifications,
      monitorSpecifications: product.monitorSpecifications,
      price: product.price,
      tax: product.tax,
      href: product.affiliateUrl,
      sponsored: true,
      state:
        product.status === "eligible"
          ? "条件に適合"
          : product.status === "excluded"
            ? "条件不適合"
            : "判定保留",
      reasons: product.reasons,
      axes: [],
    }));
  return (
    <Show
      when={!expired()}
      fallback={
        <p class="status" role="status">
          表示期限が切れました。「比較する」で再取得してください。
        </p>
      }
    >
      <ProductTable products={products()} monitor />
      <div class="result-footer">
        <span>入力商品を含む{props.data.products.length}商品 · 掲載価格に別途送料は含みません</span>
        <span>確認 {new Date(props.data.source.observedAt).toLocaleString("ja-JP")}</span>
      </div>
      <Show when={props.data.status === "needs_information"}>
        <p class="result-notice" role="status">
          条件への適合や価格に未確認の情報があります。仕様を推測で補わず、価格順位を保留しています。
        </p>
      </Show>
      <Show when={props.data.status === "no_match"}>
        <p class="result-notice" role="status">
          取得した商品の中に条件を満たすモニターがありませんでした。条件を変更して再取得してください。
        </p>
      </Show>
      <details class="details evidence">
        <summary>比較条件・出典</summary>
        <p>
          24〜32型の仕事用モニターを対象に、入力商品と最大5候補を比較します。価格順は条件への適合が確認できた商品の税込掲載価格で決まります。同額は同順位です。送料・クーポン・ポイント還元は順位に含みません。
        </p>
        <p>
          仕様は楽天の商品情報・製品情報の明示された値から取得します。USB-C端子の存在だけでは映像入力や給電への対応を判断しません。「未確認」は非対応を意味しません。
        </p>
        <For each={props.data.products}>
          {(product) => (
            <div class="evidence-product">
              <a href={product.canonicalUrl} target="_blank" rel="noopener noreferrer">
                {product.title}
              </a>
              <span>
                {product.shopName} · {product.specifications.model ?? "型番未確認"} · JAN{" "}
                {product.specifications.gtin ?? "未確認"}
              </span>
              <span>
                {product.shipping === "included" ? "API上は送料込み" : "送料別・金額未確認"}
              </span>
              <For
                each={[
                  ...new Set(product.reasons.map((reason) => monitorReasons[reason] ?? reason)),
                ]}
              >
                {(reason) => <span>{reason}</span>}
              </For>
            </div>
          )}
        </For>
      </details>
    </Show>
  );
}

function updateMonitorTitle(sort: "price" | "specifications"): void {
  document.title = `${sort === "price" ? "価格順" : "仕様比較"} | 仕事用モニター比較`;
}

function MonitorApp(): JSX.Element {
  const [sort, setSort] = createSignal<"price" | "specifications">("specifications");
  const [query, setQuery] = createSignal<
    | Readonly<{
        url: string;
        conditions: MonitorConditions;
        sort: "price" | "specifications";
        keyword: string;
        accessToken: string;
      }>
    | undefined
  >();
  const [result] = createResource(query, async (input): Promise<ViewResult<MonitorComparison>> => {
    try {
      return {
        tag: "ok",
        value: await compareMonitors(input.url, input.conditions, input.sort, {
          keyword: input.keyword,
          accessToken: input.accessToken,
        }),
      };
    } catch (error: unknown) {
      return { tag: "err", message: error instanceof Error ? error.message : "通信に失敗しました" };
    }
  });
  createEffect(() => {
    updateMonitorTitle(sort());
  });
  const reset = (): void => {
    setQuery(undefined);
  };
  return (
    <>
      <header class="top">
        <div class="top-inner">
          <a class="brand" href="/">
            仕事用モニター比較
          </a>
          <span class="build-label">動作確認版</span>
        </div>
      </header>
      <main>
        <p class="monitor-scope">
          24〜32型、3〜5万円帯を中心に比較。条件を満たす低価格の商品も候補に含めます。
        </p>
        <form
          class="url-panel"
          onInput={reset}
          onChange={reset}
          onSubmit={(event) => {
            event.preventDefault();
            if (result.loading) {
              return;
            }
            const data = new FormData(event.currentTarget);
            const text = (name: string): string => {
              const value = data.get(name);
              return typeof value === "string" ? value.trim() : "";
            };
            const size = text("screen-size");
            const resolution = text("resolution");
            const power = text("usb-c-power");
            const conditions: MonitorConditions = {
              screenSize: size === "24" ? 24 : size === "27" ? 27 : size === "32" ? 32 : null,
              minResolution: resolution === "qhd" ? "qhd" : resolution === "4k" ? "4k" : null,
              usbCPowerW: power === "65" ? 65 : power === "90" ? 90 : 0,
              heightAdjustable: data.get("height-adjustable") === "on",
            };
            setQuery({
              url: text("url"),
              conditions,
              sort: sort(),
              keyword: text("keyword"),
              accessToken: text("access-token"),
            });
          }}
        >
          <label for="monitor-url">楽天のモニターURLを貼り付けて比較</label>
          <div class="search">
            <div class="url-input-wrap">
              <input
                id="monitor-url"
                name="url"
                type="url"
                required
                maxLength={2048}
                placeholder="https://item.rakuten.co.jp/ショップ/商品/"
              />
            </div>
            <button class="primary-button compare-button" type="submit" disabled={result.loading}>
              {result.loading ? "比較中…" : "比較する"}
            </button>
          </div>
          <fieldset class="monitor-conditions">
            <legend>必要な条件を選択</legend>
            <div class="condition-grid">
              <label class="field">
                画面サイズ
                <select name="screen-size">
                  <option value="any">指定なし</option>
                  <option value="24">24型前後</option>
                  <option value="27">27型前後</option>
                  <option value="32">32型前後</option>
                </select>
              </label>
              <label class="field">
                最低解像度
                <select name="resolution">
                  <option value="any">指定なし</option>
                  <option value="qhd">WQHD（2560 × 1440）以上</option>
                  <option value="4k">4K（3840 × 2160）以上</option>
                </select>
              </label>
              <label class="field">
                USB-Cで映像入力・給電
                <select name="usb-c-power">
                  <option value="0">指定なし</option>
                  <option value="65">65W以上</option>
                  <option value="90">90W以上</option>
                </select>
              </label>
              <label class="field">
                表示方法
                <select
                  value={sort()}
                  onChange={(event) =>
                    setSort(event.currentTarget.value === "price" ? "price" : "specifications")
                  }
                >
                  <option value="specifications">仕様比較</option>
                  <option value="price">税込掲載価格順</option>
                </select>
              </label>
            </div>
            <label class="confirm">
              <input type="checkbox" name="height-adjustable" />
              高さ調整を必須にする
            </label>
          </fieldset>
          <div class="tools-row">
            <details class="details connection">
              <summary>接続設定</summary>
              <div class="connection-fields">
                <label for="monitor-access-token">動作確認用トークン</label>
                <input
                  id="monitor-access-token"
                  name="access-token"
                  type="password"
                  autocomplete="off"
                />
                <label for="monitor-keyword">入力商品を探す補助の商品名</label>
                <input
                  id="monitor-keyword"
                  name="keyword"
                  type="text"
                  maxLength={128}
                  placeholder="URLで見つからない場合に入力"
                />
              </div>
            </details>
            <details class="details help">
              <summary>使い方</summary>
              <p>
                モニターの楽天商品URLと必要な条件を指定してください。取得できない仕様は「未確認」と表示します。条件を変更した後は「比較する」で再取得します。
              </p>
            </details>
          </div>
        </form>
        <div class="bar">
          <h1>
            {sort() === "price" ? "条件に合うモニターの価格比較" : "仕事用モニターの仕様比較"}
          </h1>
          <span class="count">入力商品＋最大5候補</span>
        </div>
        <Show when={result.loading}>
          <p class="status loading" role="status">
            モニターの価格と仕様を取得しています…
          </p>
        </Show>
        <Show when={query() === undefined || result.loading ? undefined : result()}>
          {(state) => {
            const value = state();
            return value.tag === "ok" ? (
              <MonitorResults data={value.value} />
            ) : (
              <p class="status error" role="alert">
                {value.message}
              </p>
            );
          }}
        </Show>
        <Show when={query() === undefined && !result.loading}>
          <section class="empty-state">
            <h2>必要な仕様を、同じ項目で比較</h2>
            <p>
              画面サイズ・解像度・リフレッシュレート・USB-C映像入力と給電・映像端子・高さ調整・保証を一覧で確認できます。
            </p>
          </section>
        </Show>
        <p class="affiliate-notice">
          商品リンクは楽天アフィリエイト広告です。購入により運営者に報酬が入る場合があります。報酬額は比較条件や価格順位に影響しません。
        </p>
      </main>
    </>
  );
}

export function App(): JSX.Element {
  return /^\/securities\/?$/.test(window.location.pathname) ? (
    <SecuritiesApp />
  ) : /^\/furusato\/?$/.test(window.location.pathname) ? (
    <FurusatoApp />
  ) : window.location.pathname === "/compare/charger/" ? (
    <ChargerDiagnostic />
  ) : window.location.pathname === "/compare/monitor/" ? (
    <MonitorApp />
  ) : (
    <ConsumerApp />
  );
}

function ChargerDiagnostic(): JSX.Element {
  const [mode, setMode] = createSignal<ComparisonMode>(currentMode());
  const [url, setUrl] = createSignal("");
  const [requirements, setRequirements] = createSignal("");
  const [keyword, setKeyword] = createSignal("");
  const [accessToken, setAccessToken] = createSignal("");
  const [sourceExpired, setSourceExpired] = createSignal(false);
  const [query, setQuery] = createSignal<
    | Readonly<{ url: string; keyword: string; accessToken: string; requirements: string }>
    | undefined
  >();
  const [liveQuery, setLiveQuery] = createSignal<
    | Readonly<{
        source: LiveProduct;
        mode: ComparisonMode;
        requirements: string;
        keyword: string;
        accessToken: string;
      }>
    | undefined
  >();
  const [chargerQuery, setChargerQuery] = createSignal<
    | Readonly<{
        source: Investigation;
        use: ChargerUse;
        notes: string;
        keyword: string;
        accessToken: string;
      }>
    | undefined
  >();
  const resetComparison = (): void => {
    setLiveQuery(undefined);
    setChargerQuery(undefined);
  };
  const resetSource = (): void => {
    resetComparison();
    setQuery(undefined);
  };
  const [result] = createResource(query, async (input): Promise<ViewResult<Investigation>> => {
    try {
      return {
        tag: "ok",
        value: await investigateProduct(input.url, {
          keyword: input.keyword,
          accessToken: input.accessToken,
        }),
      };
    } catch (error: unknown) {
      return { tag: "err", message: error instanceof Error ? error.message : "通信に失敗しました" };
    }
  });
  const [liveComparison] = createResource(
    liveQuery,
    async (input): Promise<ViewResult<ProductComparison>> => {
      try {
        return {
          tag: "ok",
          value: await compareProducts(input.source, input.mode, input.requirements, {
            keyword: input.keyword,
            accessToken: input.accessToken,
          }),
        };
      } catch (error: unknown) {
        return {
          tag: "err",
          message: error instanceof Error ? error.message : "通信に失敗しました",
        };
      }
    },
  );
  const [chargerComparison] = createResource(
    chargerQuery,
    async (input): Promise<ViewResult<ChargerComparison>> => {
      try {
        return {
          tag: "ok",
          value: await compareChargers(input.source, input.use, input.notes, {
            keyword: input.keyword,
            accessToken: input.accessToken,
          }),
        };
      } catch (error: unknown) {
        return {
          tag: "err",
          message: error instanceof Error ? error.message : "通信に失敗しました",
        };
      }
    },
  );
  const sourceData = (): Investigation | undefined => {
    const state = query() === undefined || result.loading ? undefined : result();
    return state?.tag === "ok" ? state.value : undefined;
  };
  const queueLive = (source: LiveProduct): void => {
    setLiveQuery({
      source,
      mode: mode(),
      requirements: query()?.requirements ?? "",
      keyword: keyword(),
      accessToken: accessToken(),
    });
  };
  createEffect(() => {
    const source = sourceData();
    setSourceExpired(false);
    if (source !== undefined && source.mode !== "demo") {
      onCleanup(
        expireAt(source.expiresAt, () => {
          setSourceExpired(true);
          resetComparison();
        }),
      );
    }
  });
  createEffect(() => {
    const source = sourceData();
    if (source?.mode === "live" && !sourceExpired()) {
      queueLive(source);
    }
  });
  createEffect(() => {
    updatePageTitle(mode());
  });
  const onPopState = (): void => {
    setMode(currentMode());
    setChargerQuery(undefined);
  };
  window.addEventListener("popstate", onPopState);
  onCleanup(() => {
    window.removeEventListener("popstate", onPopState);
  });
  const busy = (): boolean => result.loading || liveComparison.loading || chargerComparison.loading;
  return (
    <>
      <header class="top">
        <div class="top-inner">
          <a
            class="brand"
            href="/"
            onClick={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                window.history.pushState(null, "", "/");
                setMode("ai");
                setChargerQuery(undefined);
              }
            }}
          >
            <svg class="brand-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path
                d="M16 4v24M6 8h20M10 28h12M7 8l-5 10h10L7 8Zm18 0-5 10h10L25 8Z"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {pages.find((page) => page.id === mode())?.label ?? "商品比較"}
          </a>
          <nav class="mode-nav" aria-label="比較メニュー">
            <For each={pages}>
              {(page) => (
                <a
                  href={page.path}
                  aria-current={mode() === page.id ? "page" : undefined}
                  onClick={(event) => {
                    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                      event.preventDefault();
                      window.history.pushState(null, "", page.path);
                      setMode(page.id);
                      setChargerQuery(undefined);
                    }
                  }}
                >
                  {page.label}
                </a>
              )}
            </For>
          </nav>
          <span class="build-label">動作確認版</span>
        </div>
      </header>
      <main>
        <form
          class="url-panel"
          onSubmit={(event) => {
            event.preventDefault();
            resetComparison();
            setQuery({
              url: url().trim(),
              keyword: keyword(),
              accessToken: accessToken(),
              requirements: requirements(),
            });
          }}
        >
          <label for="product-url">商品URLを貼り付けて比較</label>
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
                id="product-url"
                type="url"
                required
                placeholder="https://item.rakuten.co.jp/ショップ/商品/"
                value={url()}
                onInput={(event) => {
                  setUrl(event.currentTarget.value);
                  resetSource();
                }}
              />
            </div>
            <button class="primary-button compare-button" type="submit" disabled={busy()}>
              {busy() ? "比較中…" : "比較する"}
            </button>
          </div>
          <div class="requirements">
            <label for="requirements">
              希望条件 <span>任意</span>
            </label>
            <input
              id="requirements"
              type="text"
              maxLength={200}
              placeholder="例：持ち歩き用・65W以上・USB-Cが2ポート"
              value={requirements()}
              onInput={(event) => {
                setRequirements(event.currentTarget.value);
                resetSource();
              }}
            />
          </div>
        </form>
        <div class="tools-row">
          <details class="details connection">
            <summary>接続設定</summary>
            <div class="connection-fields">
              <label for="access-token">動作確認用トークン</label>
              <input
                id="access-token"
                type="password"
                autocomplete="off"
                value={accessToken()}
                onInput={(event) => {
                  setAccessToken(event.currentTarget.value);
                  resetSource();
                }}
              />
              <label for="search-keyword">補助の商品名</label>
              <input
                id="search-keyword"
                type="text"
                placeholder="URLで見つからない場合に入力"
                value={keyword()}
                onInput={(event) => {
                  setKeyword(event.currentTarget.value);
                  resetSource();
                }}
              />
            </div>
          </details>
          <details class="details help">
            <summary>使い方</summary>
            <p>
              楽天の商品URLを入力すると、別モデルの類似商品を最大5件比較します。情報が不足する商品は順位を保留します。
            </p>
          </details>
        </div>
        <div class="bar">
          <h1>
            {chargerQuery() === undefined
              ? pages.find((page) => page.id === mode())?.title
              : "充電条件への適合比較"}
          </h1>
          <span class="count">最大5商品</span>
        </div>
        <Show when={result.loading || liveComparison.loading}>
          <p class="status loading" role="status">
            {result.loading
              ? "入力商品の情報を取得しています…"
              : "類似商品の価格・仕様を取得しています…"}
          </p>
        </Show>
        <Show when={query() === undefined || result.loading ? undefined : result()}>
          {(state) => {
            const value = state();
            return value.tag === "err" ? (
              <p class="status error" role="alert">
                {value.message}
              </p>
            ) : undefined;
          }}
        </Show>
        <Show when={sourceExpired()}>
          <p class="status" role="status">
            入力商品の表示期限が切れました。「比較する」で再取得してください。
          </p>
        </Show>
        <Show
          when={liveQuery() === undefined || liveComparison.loading ? undefined : liveComparison()}
        >
          {(state) => {
            const value = state();
            return value.tag === "ok" ? (
              <LiveResults data={value.value} />
            ) : (
              <p class="status error" role="alert">
                {value.message}
              </p>
            );
          }}
        </Show>
        <Show when={chargerQuery() !== undefined && chargerComparison.loading}>
          <p class="status loading" role="status">
            充電条件への適合を比較しています…
          </p>
        </Show>
        <Show
          when={
            chargerQuery() === undefined || chargerComparison.loading
              ? undefined
              : chargerComparison()
          }
        >
          {(state) => {
            const value = state();
            return value.tag === "ok" ? (
              <ChargerResults data={value.value} />
            ) : (
              <p class="status error" role="alert">
                {value.message}
              </p>
            );
          }}
        </Show>
        <Show
          when={sourceData()}
          fallback={
            <section class="empty-state">
              <div class="empty-columns" aria-hidden="true">
                <For each={[1, 2, 3, 4, 5]}>
                  {(number) => (
                    <div>
                      <span>{number}</span>
                      <div />
                      <div />
                      <div />
                    </div>
                  )}
                </For>
              </div>
              <h2>類似商品の違いを、横並びで確認</h2>
              <p>価格・出力・ポート数・重さ・保証を比較します。</p>
              <button
                class="text-button"
                type="button"
                onClick={() => {
                  resetSource();
                  setUrl("https://www.elecom.co.jp/products/MPA-ACCP4365BK.html");
                }}
              >
                公式URLで動作確認
              </button>
              <button
                class="text-button"
                type="button"
                onClick={() => {
                  resetSource();
                  setUrl("https://item.rakuten.co.jp/demo-shop/demo-product/");
                }}
              >
                架空デモで動作確認
              </button>
            </section>
          }
        >
          {(source) => (
            <Show when={source().mode !== "live"}>
              <ChargerConditions
                source={source()}
                disabled={sourceExpired() || busy()}
                onChange={() => {
                  setChargerQuery(undefined);
                }}
                onCompare={(use, notes) => {
                  setLiveQuery(undefined);
                  setChargerQuery({
                    source: source(),
                    use,
                    notes,
                    keyword: keyword(),
                    accessToken: accessToken(),
                  });
                }}
              />
            </Show>
          )}
        </Show>
      </main>
    </>
  );
}
