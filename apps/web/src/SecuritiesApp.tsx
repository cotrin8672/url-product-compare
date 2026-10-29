/** @jsxImportSource solid-js */
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  createComparisonRequestScope,
  fetchSecuritiesComparison,
  prepareSecuritiesSubmission,
  securitiesDraftMatches,
} from "@app/api-client";
import type {
  SecuritiesComparison,
  SecuritiesRequest,
  SecuritiesDraft,
  SecuritiesFormIssue,
  SecuritiesSubmission,
} from "@app/api-client";

import { SecuritiesAdImpression } from "./components/SecuritiesAdImpression.js";
import { ServiceHeader } from "./components/ServiceHeader.js";

import "./securities.css";

const number = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
type Broker = SecuritiesComparison["rows"][number];

function FieldError(props: Readonly<{ field: string; message: string | undefined }>): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <small class="securities-field-error" id={"securities-" + props.field + "-error"}>
          {message()}
        </small>
      )}
    </Show>
  );
}

function date(value: string): string {
  return new Date(value).toLocaleString("ja-JP");
}
function currentTime(): number {
  return Date.now();
}
function optionalAmount(input: HTMLInputElement): number | null {
  return input.validity.badInput ? NaN : input.value === "" ? null : input.valueAsNumber;
}
function condition(row: Broker, request: SecuritiesRequest): string {
  if (request.mode === "fund") {
    if (row.id === "sbi") {
      return "年間利用 " + number.format(request.annualShoppingYen) + "円";
    }
    if (row.id === "monex") {
      return "月間利用 " + number.format(request.monthlyShoppingYen) + "円";
    }
    return request.rakutenFundBand === "unknown"
      ? "ファンド区分未指定"
      : "代行手数料 " + (request.rakutenFundBand === "low" ? "0.4%未満" : "0.4%以上");
  }
  if (row.id === "sbi") {
    return request.sbiElectronicDelivery
      ? "電子交付などの条件設定済み"
      : "電子交付などの条件未確認";
  }
  if (row.id === "rakuten") {
    return request.account === "nisa"
      ? "NISA成長投資枠"
      : request.rakutenZeroCourse
        ? "ゼロコース設定済み"
        : "ゼロコース未確認";
  }
  return request.account === "nisa" ? "NISA成長投資枠" : "取引毎手数料コース";
}

function BrokerLink(props: Readonly<{ row: Broker; now: number }>): JSX.Element {
  const sponsored = (): boolean =>
    props.row.link.provider !== "official" &&
    props.row.link.creative !== null &&
    props.row.link.approvedUntil !== null &&
    Date.parse(props.row.link.approvedUntil) > props.now;
  return (
    <>
      <a
        class="purchase-button securities-link"
        href={sponsored() ? props.row.link.url : props.row.officialUrl}
        target="_blank"
        referrerpolicy={sponsored() ? "no-referrer-when-downgrade" : undefined}
        rel={sponsored() ? "sponsored nofollow noopener" : "noopener noreferrer"}
      >
        {sponsored() ? props.row.link.creative?.text : "公式サイト"}
        <Show when={sponsored() ? props.row.link.creative?.impressionUrl : null}>
          {(url) => <SecuritiesAdImpression url={url()} />}
        </Show>
        <Show when={!sponsored()}>
          <span class="securities-link-arrow" aria-hidden="true">
            {" "}
            ↗
          </span>
        </Show>
      </a>
      <Show when={sponsored()}>
        <small class="securities-ad-label">広告</small>
      </Show>
    </>
  );
}

function ComparisonTable(
  props: Readonly<{
    data: SecuritiesComparison;
    submission: SecuritiesSubmission;
    dirty: boolean;
    now: number;
    configure: (broker: Broker["id"]) => void;
  }>,
): JSX.Element {
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const fresh = (row: Broker): boolean =>
    row.status !== "review_due" &&
    Date.parse(row.reviewAfter) > props.now &&
    Date.parse(row.checkedAt) <= props.now &&
    (props.data.unit !== "points" || Date.parse(row.pointsFrom) <= props.now);
  const missing = (row: Broker): boolean => props.submission.missing.includes(row.id);
  const complete = (): boolean =>
    props.data.rows.every(
      (row) => fresh(row) && !missing(row) && row.status === "calculated" && row.value !== null,
    );
  const checkedAt = (): string =>
    props.data.rows.reduce(
      (oldest, row) => (row.checkedAt < oldest ? row.checkedAt : oldest),
      props.data.generatedAt,
    );
  const summary = (): string => {
    const request = props.data.request;
    return request.mode === "fund"
      ? "毎月 " + number.format(request.monthlyYen) + "円のカード積立"
      : (request.account === "nisa" ? "NISA" : "課税口座") +
          "・" +
          number.format(request.tradeYen) +
          "円 × " +
          number.format(request.orders) +
          "注文";
  };
  return (
    <section aria-labelledby="securities-result-heading">
      <div class="securities-result-heading">
        <h2 id="securities-result-heading">
          {props.data.unit === "points" ? "積立ポイントを比較" : "売買手数料を比較"}
        </h2>
        <span>
          {props.dirty ? "前回の結果：" : ""}
          {summary()}
        </span>
      </div>
      <p class="securities-freshness">
        <span>
          公式条件確認：
          <time dateTime={checkedAt()}>{new Date(checkedAt()).toLocaleDateString("ja-JP")}</time>
        </span>
        <Show when={props.data.rows.some((row) => !fresh(row))}>
          <strong role="status">
            運営による公式条件の更新待ちです。対象の試算は一時停止中です。入力変更では解消しません。
          </strong>
        </Show>
      </p>
      <div class="securities-table-wrap" classList={{ "is-stale": props.dirty }}>
        <table class="comparison-table securities-table">
          <caption class="sr-only">公式資料の確認日と条件に基づく3社比較</caption>
          <thead>
            <tr>
              <th scope="col">証券会社</th>
              <For each={props.data.rows}>
                {(row) => (
                  <th scope="col">
                    <a href={row.officialUrl} target="_blank" rel="noopener noreferrer">
                      {row.name}
                    </a>
                    <Show when={props.data.unit === "points"}>
                      <small class="securities-card">{row.card}</small>
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <tr class="securities-value-row">
              <th scope="row">
                {props.data.unit === "points" ? "月間ポイント" : "合計手数料"}
                <small class="securities-block">
                  {props.data.unit === "points" ? "端数調整前" : "税込"}
                </small>
              </th>
              <For each={props.data.rows}>
                {(row) => (
                  <td>
                    <Show
                      when={row.value !== null && fresh(row) && !missing(row)}
                      fallback={
                        <div class="securities-unavailable">
                          <span>
                            {!fresh(row)
                              ? "データ更新待ち"
                              : row.status === "out_of_scope"
                                ? "対象範囲外"
                                : "条件未確認"}
                          </span>
                          <Show
                            when={
                              fresh(row) && (missing(row) || row.status === "needs_information")
                            }
                          >
                            <button
                              type="button"
                              onClick={() => {
                                props.configure(row.id);
                              }}
                            >
                              条件を設定
                            </button>
                          </Show>
                        </div>
                      }
                    >
                      <strong
                        class="securities-metric"
                        classList={{
                          "securities-metric-long": number.format(row.value ?? 0).length > 4,
                        }}
                      >
                        <span class="securities-metric-value">{number.format(row.value ?? 0)}</span>
                        <small>{props.data.unit === "points" ? " pt" : " 円"}</small>
                      </strong>
                    </Show>
                    <Show when={props.data.unit === "points"}>
                      <small class="securities-block">{row.pointName}</small>
                    </Show>
                    <Show when={complete() && row.rank !== null}>
                      <span class="securities-rank">
                        <span class="securities-rank-label">手数料 </span>
                        {row.rank}位
                      </span>
                    </Show>
                  </td>
                )}
              </For>
            </tr>
            <tr class="securities-condition-row">
              <th scope="row">適用条件</th>
              <For each={props.data.rows}>
                {(row) => (
                  <td>
                    {missing(row)
                      ? row.id === "sbi"
                        ? "年間利用額 未入力"
                        : "月間利用額 未入力"
                      : condition(row, props.data.request)}
                  </td>
                )}
              </For>
            </tr>
            <tr>
              <th scope="row">申込案内</th>
              <For each={props.data.rows}>
                {(row) => (
                  <td>
                    <BrokerLink row={row} now={props.now} />
                  </td>
                )}
              </For>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="securities-note">
        {props.data.unit === "points"
          ? "ポイントの種類・利用条件が異なるため、総合順位は付けていません。代表カードの通常付与分で比較します。"
          : "条件を確認できた手数料のみ表示します。3社すべての条件が揃った場合に順位を表示します。"}
      </p>
      <button
        class="consumer-details-toggle securities-details-toggle"
        type="button"
        aria-expanded={detailsOpen()}
        aria-controls="securities-evidence"
        onClick={() => setDetailsOpen(!detailsOpen())}
      >
        <span>{detailsOpen() ? "−" : "＋"} 計算内訳・適用条件・出典</span>
        <span>{detailsOpen() ? "閉じる" : "詳しく見る"}</span>
      </button>
      <Show when={detailsOpen()}>
        <div id="securities-evidence">
          <div class="securities-evidence-grid">
            <For each={props.data.rows}>
              {(row) => (
                <section class="securities-evidence-card">
                  <h3>{row.name}</h3>
                  <p>
                    {!fresh(row)
                      ? "運営による公式条件の更新待ちです。試算・順位を保留しています。"
                      : missing(row)
                        ? "カード利用額が未入力のため、ポイントの試算を保留しています。詳細条件で利用額を設定してください。"
                        : row.reason}
                  </p>
                  <Show when={fresh(row) && !missing(row) && row.breakdown.length > 0}>
                    <ul class="securities-breakdown">
                      <For each={row.breakdown}>
                        {(item) => (
                          <li>
                            {item.label}：{number.format(item.value)}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={props.data.unit === "points"}>
                    <p>
                      {row.card}・積立額 原則月{number.format(row.minimumCardYen)}円〜10万円
                    </p>
                  </Show>
                  <ul>
                    <For each={row.notes}>{(note) => <li>{note}</li>}</For>
                  </ul>
                  <p class="securities-dates">
                    確認：<time dateTime={row.checkedAt}>{date(row.checkedAt)}</time>
                    <br />
                    再確認予定：{date(row.reviewAfter)}
                  </p>
                  <ul class="securities-sources">
                    <For each={row.sources}>
                      {(source) => (
                        <li>
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.label} ↗
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </div>
          <div class="securities-notices">
            <For each={props.data.notices}>{(notice) => <p>{notice}</p>}</For>
            <p>試算日時：{date(props.data.generatedAt)}</p>
          </div>
        </div>
      </Show>
      <p class="securities-footnote">
        <Show when={props.data.unit === "points"}>カード年会費・上乗せ特典等は含みません。</Show>
        広告による報酬は計算・順位に影響しません。申込み前に公式の条件をご確認ください。
      </p>
    </section>
  );
}

export function SecuritiesApp(): JSX.Element {
  const [mode, setMode] = createSignal<"fund" | "stock">("fund");
  const [monthlyYen, setMonthlyYen] = createSignal(30_000);
  const [monthlyShoppingYen, setMonthlyShoppingYen] = createSignal<number | null>(null);
  const [annualShoppingYen, setAnnualShoppingYen] = createSignal<number | null>(null);
  const [band, setBand] = createSignal<"low" | "high" | "unknown">("unknown");
  const [account, setAccount] = createSignal<"nisa" | "taxable">("nisa");
  const [tradeYen, setTradeYen] = createSignal(100_000);
  const [orders, setOrders] = createSignal(1);
  const [electronic, setElectronic] = createSignal(false);
  const [zero, setZero] = createSignal(false);
  const [optionsOpen, setOptionsOpen] = createSignal(false);
  const [showErrors, setShowErrors] = createSignal(false);
  const [now, setNow] = createSignal(currentTime());
  const [submitted, setSubmitted] = createSignal<SecuritiesSubmission>({
    request: {
      mode: "fund",
      monthlyYen: 30_000,
      monthlyShoppingYen: 0,
      annualShoppingYen: 0,
      rakutenFundBand: "unknown",
    },
    missing: ["sbi", "monex"],
  });
  const scope = createComparisonRequestScope();
  const [comparison] = createResource(submitted, async (submission) => {
    const active = scope.begin();
    const data = await fetchSecuritiesComparison(submission.request, { signal: active.signal });
    return { data, submission };
  });
  const timer = setInterval(() => setNow(currentTime()), 30_000);
  document.body.classList.add("consumer-ready", "securities-ready");
  onCleanup(() => {
    clearInterval(timer);
    scope.invalidate();
    document.body.classList.remove("consumer-ready", "securities-ready");
  });
  const draft = (selectedMode: "fund" | "stock" = mode()): SecuritiesDraft =>
    selectedMode === "fund"
      ? {
          mode: "fund",
          monthlyYen: monthlyYen(),
          monthlyShoppingYen: monthlyShoppingYen(),
          annualShoppingYen: annualShoppingYen(),
          rakutenFundBand: band(),
        }
      : {
          mode: "stock",
          account: account(),
          tradeYen: tradeYen(),
          orders: orders(),
          sbiElectronicDelivery: electronic(),
          rakutenZeroCourse: zero(),
        };
  const issues = (): readonly SecuritiesFormIssue[] => {
    const prepared = prepareSecuritiesSubmission(draft());
    return showErrors() && !prepared.ok ? prepared.issues : [];
  };
  const fieldMessage = (field: SecuritiesFormIssue["field"]): string | undefined =>
    issues().find((issue) => issue.field === field)?.message;
  const focusInput = (field: string, details: boolean): void => {
    if (details) {
      setOptionsOpen(true);
    }
    queueMicrotask(() => {
      const input = document.getElementById("securities-" + field);
      input?.focus();
      input?.scrollIntoView({ block: "nearest" });
    });
  };
  const configure = (broker: Broker["id"]): void => {
    const field =
      mode() === "fund"
        ? broker === "sbi"
          ? "annualShoppingYen"
          : broker === "monex"
            ? "monthlyShoppingYen"
            : "band"
        : broker === "sbi"
          ? "electronic"
          : "zero";
    focusInput(field, true);
  };
  const submit = (selectedMode: "fund" | "stock" = mode()): void => {
    const prepared = prepareSecuritiesSubmission(draft(selectedMode));
    if (!prepared.ok) {
      setShowErrors(true);
      const first = prepared.issues[0];
      if (first !== undefined) {
        focusInput(
          first.field,
          first.field === "annualShoppingYen" || first.field === "monthlyShoppingYen",
        );
      }
      return;
    }
    setShowErrors(false);
    setSubmitted(prepared.submission);
    setOptionsOpen(false);
  };
  const changeMode = (next: "fund" | "stock"): void => {
    setMode(next);
    submit(next);
  };
  return (
    <>
      <ServiceHeader current="securities" />
      <main class="consumer-main securities-page">
        <div class="securities-title">
          <h1>証券会社を比べる</h1>
          <p>SBI・楽天・マネックス</p>
        </div>
        <form
          class="url-panel securities-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div class="securities-toolbar">
            <div class="securities-tabs" role="group" aria-label="比較するサービス">
              <button
                type="button"
                aria-pressed={mode() === "fund"}
                onClick={() => {
                  changeMode("fund");
                }}
              >
                NISA・投信積立
              </button>
              <button
                type="button"
                aria-pressed={mode() === "stock"}
                onClick={() => {
                  changeMode("stock");
                }}
              >
                国内現物株
              </button>
            </div>
            <Show
              when={mode() === "fund"}
              fallback={
                <>
                  <label class="securities-account">
                    口座種別
                    <select
                      aria-label="口座種別"
                      value={account()}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value === "nisa" || value === "taxable") {
                          setAccount(value);
                        }
                      }}
                    >
                      <option value="nisa">NISA成長投資枠</option>
                      <option value="taxable">課税口座</option>
                    </select>
                  </label>
                  <label>
                    1注文の約定金額
                    <span class="securities-input-unit">
                      <input
                        id="securities-tradeYen"
                        aria-invalid={fieldMessage("tradeYen") !== undefined}
                        aria-describedby={
                          fieldMessage("tradeYen") === undefined
                            ? undefined
                            : "securities-tradeYen-error"
                        }
                        aria-label="1注文の約定金額（円）"
                        type="number"
                        min="1"
                        max="100000000"
                        step="1"
                        required
                        value={tradeYen()}
                        onInput={(event) => setTradeYen(event.currentTarget.valueAsNumber)}
                      />
                      <span>円</span>
                    </span>
                    <FieldError field="tradeYen" message={fieldMessage("tradeYen")} />
                  </label>
                  <label class="securities-orders">
                    注文数
                    <input
                      id="securities-orders"
                      aria-invalid={fieldMessage("orders") !== undefined}
                      aria-describedby={
                        fieldMessage("orders") === undefined ? undefined : "securities-orders-error"
                      }
                      aria-label="約定する注文数"
                      type="number"
                      min="1"
                      max="1000"
                      step="1"
                      required
                      value={orders()}
                      onInput={(event) => setOrders(event.currentTarget.valueAsNumber)}
                    />
                    <FieldError field="orders" message={fieldMessage("orders")} />
                  </label>
                </>
              }
            >
              <label>
                毎月のカード積立額
                <span class="securities-input-unit">
                  <input
                    id="securities-monthlyYen"
                    aria-invalid={fieldMessage("monthlyYen") !== undefined}
                    aria-describedby={
                      fieldMessage("monthlyYen") === undefined
                        ? undefined
                        : "securities-monthlyYen-error"
                    }
                    aria-label="毎月のカード積立額（円）"
                    type="number"
                    min="100"
                    max="100000"
                    step="1"
                    required
                    value={monthlyYen()}
                    onInput={(event) => setMonthlyYen(event.currentTarget.valueAsNumber)}
                  />
                  <span>円</span>
                </span>
                <FieldError field="monthlyYen" message={fieldMessage("monthlyYen")} />
              </label>
            </Show>
            <button
              class="securities-options-toggle"
              type="button"
              aria-expanded={optionsOpen()}
              aria-controls="securities-options"
              onClick={() => setOptionsOpen(!optionsOpen())}
            >
              詳細条件 {optionsOpen() ? "−" : "＋"}
            </button>
            <button class="primary-button" type="submit" disabled={comparison.loading}>
              {comparison.loading ? "計算中…" : "比較する"}
            </button>
          </div>
          <Show
            when={
              mode() === "fund" && (annualShoppingYen() === null || monthlyShoppingYen() === null)
            }
          >
            <p class="securities-form-hint">
              利用額が未入力の会社は試算を保留します。詳細条件から設定してください（0円の場合は「0」を入力）。
            </p>
          </Show>
          <Show when={issues().length > 0}>
            <div class="securities-validation" role="alert">
              <p>入力内容を確認してください。</p>
              <ul>
                <For each={issues()}>
                  {(issue) => (
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          focusInput(
                            issue.field,
                            issue.field === "annualShoppingYen" ||
                              issue.field === "monthlyShoppingYen",
                          );
                        }}
                      >
                        {issue.message}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={optionsOpen()}>
            <div id="securities-options" class="securities-options">
              <Show
                when={mode() === "fund"}
                fallback={
                  <>
                    <label class="securities-checkbox">
                      <input
                        id="securities-electronic"
                        type="checkbox"
                        checked={electronic()}
                        onChange={(event) => setElectronic(event.currentTarget.checked)}
                      />
                      <span>SBIのインターネットコース・所定の電子交付設定を満たす</span>
                    </label>
                    <label class="securities-checkbox">
                      <input
                        id="securities-zero"
                        type="checkbox"
                        checked={zero()}
                        onChange={(event) => setZero(event.currentTarget.checked)}
                      />
                      <span>楽天のゼロコース・SOR／Rクロス利用同意を満たす</span>
                    </label>
                  </>
                }
              >
                <label>
                  SBI：年間のカード利用額
                  <input
                    id="securities-annualShoppingYen"
                    aria-invalid={fieldMessage("annualShoppingYen") !== undefined}
                    aria-describedby={
                      fieldMessage("annualShoppingYen") === undefined
                        ? undefined
                        : "securities-annualShoppingYen-error"
                    }
                    aria-label="三井住友カード（NL）の判定対象年間利用額（積立を除く・円）"
                    type="number"
                    min="0"
                    max="100000000"
                    step="1"
                    placeholder="未入力（試算を保留）"
                    value={annualShoppingYen() ?? ""}
                    onInput={(event) => setAnnualShoppingYen(optionalAmount(event.currentTarget))}
                  />
                  <FieldError
                    field="annualShoppingYen"
                    message={fieldMessage("annualShoppingYen")}
                  />
                  <small>三井住友カード（NL）・入会2年目以降。積立を除く。</small>
                </label>
                <label>
                  マネックス：月間のカード利用額
                  <input
                    id="securities-monthlyShoppingYen"
                    aria-invalid={fieldMessage("monthlyShoppingYen") !== undefined}
                    aria-describedby={
                      fieldMessage("monthlyShoppingYen") === undefined
                        ? undefined
                        : "securities-monthlyShoppingYen-error"
                    }
                    aria-label="マネックスカードの対象月額利用額（積立を除く・円）"
                    type="number"
                    min="0"
                    max="10000000"
                    step="1"
                    placeholder="未入力（試算を保留）"
                    value={monthlyShoppingYen() ?? ""}
                    onInput={(event) => setMonthlyShoppingYen(optionalAmount(event.currentTarget))}
                  />
                  <FieldError
                    field="monthlyShoppingYen"
                    message={fieldMessage("monthlyShoppingYen")}
                  />
                  <small>マネックスカード・積立を除く対象利用額。</small>
                </label>
                <label>
                  楽天：ファンドの代行手数料
                  <select
                    id="securities-band"
                    aria-label="楽天のファンド代行手数料区分"
                    value={band()}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "low" || value === "high" || value === "unknown") {
                        setBand(value);
                      }
                    }}
                  >
                    <option value="unknown">わからない（試算を保留）</option>
                    <option value="low">年率0.4%未満（税込）</option>
                    <option value="high">年率0.4%以上（税込）</option>
                  </select>
                  <small>楽天カード一般。信託報酬全体ではなく代行手数料。</small>
                </label>
              </Show>
            </div>
          </Show>
        </form>
        <Show when={comparison.loading}>
          <p role="status" class="securities-note">
            比較条件を計算しています…
          </p>
        </Show>
        <Show when={comparison.error !== undefined}>
          <div class="securities-error" role="alert">
            <p>比較情報を取得できませんでした。接続を確認し、時間をおいて再試行してください。</p>
            <button
              type="button"
              onClick={() => {
                focusInput(mode() === "fund" ? "monthlyYen" : "tradeYen", false);
              }}
            >
              入力条件を確認
            </button>
            <button
              type="button"
              onClick={() => {
                submit();
              }}
            >
              再取得
            </button>
          </div>
        </Show>
        <Show
          when={
            !comparison.loading &&
            comparison.error === undefined &&
            comparison()?.data.request.mode === mode()
              ? comparison()
              : undefined
          }
        >
          {(result) => {
            const dirty = (): boolean => !securitiesDraftMatches(draft(), result().submission);
            return (
              <>
                <Show when={dirty()}>
                  <p class="securities-pending" role="status">
                    条件の変更が未反映です。「比較する」で再計算してください。下の表は前回の条件による結果です。
                  </p>
                </Show>
                <ComparisonTable
                  data={result().data}
                  submission={result().submission}
                  dirty={dirty()}
                  now={now()}
                  configure={configure}
                />
              </>
            );
          }}
        </Show>
      </main>
    </>
  );
}
