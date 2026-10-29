import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { record } from "./values.js";

type SecuritiesBrokerId = "sbi" | "rakuten" | "monex";
export type SecuritiesRequest =
  | Readonly<{
      mode: "fund";
      monthlyYen: number;
      monthlyShoppingYen: number;
      annualShoppingYen: number;
      rakutenFundBand: "low" | "high" | "unknown";
    }>
  | Readonly<{
      mode: "stock";
      account: "nisa" | "taxable";
      tradeYen: number;
      orders: number;
      sbiElectronicDelivery: boolean;
      rakutenZeroCourse: boolean;
    }>;
type SecuritiesSource = Readonly<{ label: string; url: string }>;
export type SecuritiesBroker = Readonly<{
  id: SecuritiesBrokerId;
  name: string;
  officialUrl: string;
  checkedAt: string;
  reviewAfter: string;
  card: string;
  minimumCardYen: number;
  pointName: string;
  pointsFrom: string;
  sources: readonly SecuritiesSource[];
  notes: readonly string[];
  stockFees: ReadonlyArray<Readonly<{ throughYen: number; feeYen: number }>>;
}>;
export type SecuritiesAffiliate = Readonly<{
  brokerId: SecuritiesBrokerId;
  provider: "valuecommerce" | "accesstrade";
  programId: string;
  url: string;
  approvedUntil: string;
  creative?: Readonly<{ text: string; impressionUrl: string | null }>;
}>;
type Calculation = Readonly<{
  value: number | null;
  status: "calculated" | "needs_information" | "out_of_scope" | "review_due";
  reason: string;
  breakdown: ReadonlyArray<Readonly<{ label: string; value: number }>>;
}>;
export type SecuritiesComparison = Readonly<{
  generatedAt: string;
  request: SecuritiesRequest;
  unit: "JPY" | "points";
  rows: ReadonlyArray<
    SecuritiesBroker &
      Calculation &
      Readonly<{
        rank: number | null;
        link: Readonly<{
          url: string;
          provider: "official" | "valuecommerce" | "accesstrade";
          approvedUntil: string | null;
          creative: Readonly<{ text: string; impressionUrl: string | null }> | null;
        }>;
      }>
  >;
  notices: readonly string[];
}>;

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseSecuritiesRequest(
  input: unknown,
): Result<SecuritiesRequest, Readonly<{ code: "invalid_request" }>> {
  if (!record(input)) {
    return err({ code: "invalid_request" });
  }
  if (
    input["mode"] === "fund" &&
    Object.keys(input).length === 5 &&
    integer(input["monthlyYen"], 100, 100_000) &&
    integer(input["monthlyShoppingYen"], 0, 10_000_000) &&
    integer(input["annualShoppingYen"], 0, 100_000_000) &&
    (input["rakutenFundBand"] === "low" ||
      input["rakutenFundBand"] === "high" ||
      input["rakutenFundBand"] === "unknown")
  ) {
    return ok({
      mode: "fund",
      monthlyYen: input["monthlyYen"],
      monthlyShoppingYen: input["monthlyShoppingYen"],
      annualShoppingYen: input["annualShoppingYen"],
      rakutenFundBand: input["rakutenFundBand"],
    });
  }
  if (
    input["mode"] === "stock" &&
    Object.keys(input).length === 6 &&
    (input["account"] === "nisa" || input["account"] === "taxable") &&
    integer(input["tradeYen"], 1, 100_000_000) &&
    integer(input["orders"], 1, 1000) &&
    typeof input["sbiElectronicDelivery"] === "boolean" &&
    typeof input["rakutenZeroCourse"] === "boolean"
  ) {
    return ok({
      mode: "stock",
      account: input["account"],
      tradeYen: input["tradeYen"],
      orders: input["orders"],
      sbiElectronicDelivery: input["sbiElectronicDelivery"],
      rakutenZeroCourse: input["rakutenZeroCourse"],
    });
  }
  return err({ code: "invalid_request" });
}

function unavailable(
  status: Exclude<Calculation["status"], "calculated">,
  reason: string,
): Calculation {
  return { status, reason, value: null, breakdown: [] };
}

function points(
  broker: SecuritiesBroker,
  request: Extract<SecuritiesRequest, { mode: "fund" }>,
): Calculation {
  if (request.monthlyYen < broker.minimumCardYen) {
    return unavailable(
      "out_of_scope",
      "この代表カードの最低積立額を満たしていません。現金積立の最低額とは異なります。",
    );
  }
  if (broker.id === "rakuten" && request.rakutenFundBand === "unknown") {
    return unavailable(
      "needs_information",
      "楽天カードの付与率判定には、ファンドの代行手数料区分が必要です。",
    );
  }
  if (broker.id === "monex") {
    const factor =
      request.monthlyShoppingYen < 10_000 ? 0 : request.monthlyShoppingYen < 50_000 ? 0.5 : 1;
    const breakdown = [
      {
        label: "積立額の5万円以下の部分",
        value: (Math.min(request.monthlyYen, 50_000) * 110 * factor) / 10_000,
      },
      {
        label: "5万円超〜7万円以下の部分",
        value: (Math.min(Math.max(request.monthlyYen - 50_000, 0), 20_000) * 60 * factor) / 10_000,
      },
      {
        label: "7万円超〜10万円以下の部分",
        value: (Math.max(request.monthlyYen - 70_000, 0) * 20 * factor) / 10_000,
      },
    ];
    return {
      status: "calculated",
      value: breakdown.reduce((sum, item) => sum + item.value, 0),
      breakdown,
      reason:
        "マネックスカード。対象の月額ショッピング利用額に応じた段階別試算。実付与時の端数処理前です。",
    };
  }
  const rate =
    broker.id === "sbi"
      ? request.annualShoppingYen >= 100_000
        ? 50
        : 0
      : request.rakutenFundBand === "high"
        ? 100
        : 50;
  const value = (request.monthlyYen * rate) / 10_000;
  return {
    status: "calculated",
    value,
    breakdown: [{ label: `積立額 × ${rate / 100}%`, value }],
    reason:
      broker.id === "sbi"
        ? "三井住友カード（NL）の入会2年目以降の通常付与分。積立以外の対象年間利用額で判定。Olive上乗せ・キャンペーンは含みません。"
        : "一般の楽天カードの通常付与分。ポイント利用を除いたカード決済額として試算。特別な提携カードは対象外です。",
  };
}

function stock(
  broker: SecuritiesBroker,
  request: Extract<SecuritiesRequest, { mode: "stock" }>,
): Calculation {
  if (broker.id === "sbi" && !request.sbiElectronicDelivery) {
    return unavailable(
      "needs_information",
      "SBIのインターネットコース・所定の電子交付設定が必要です。未達の場合の料金は今回の計算対象外です。",
    );
  }
  if (broker.id === "rakuten" && request.account === "taxable" && !request.rakutenZeroCourse) {
    return unavailable(
      "needs_information",
      "楽天のゼロコースとSOR・Rクロス利用同意を前提とします。他コースの料金は今回の計算対象外です。",
    );
  }
  const fee =
    broker.id === "monex" && request.account === "taxable"
      ? broker.stockFees.find((band) => request.tradeYen <= band.throughYen)?.feeYen
      : 0;
  if (fee === undefined) {
    return unavailable("out_of_scope", "対応する約定金額の料金情報がありません。");
  }
  return {
    status: "calculated",
    value: fee * request.orders,
    breakdown: [
      { label: "1注文あたり売買手数料（税込）", value: fee },
      { label: "約定した注文数", value: request.orders },
    ],
    reason:
      broker.id === "monex" && request.account === "taxable"
        ? "取引毎手数料コースの国内現物・単元株。全注文が入力と同額で約定する場合。日額コース・電話・IFA・単元未満株は対象外です。"
        : "国内現物・単元株のインターネット注文。NISAは成長投資枠の対象取引を想定。特殊注文・他の費用は含みません。",
  };
}

export function compareSecurities(
  brokers: readonly SecuritiesBroker[],
  input: unknown,
  now: string,
  affiliates: readonly SecuritiesAffiliate[] = [],
): Result<SecuritiesComparison, Readonly<{ code: "invalid_request" }>> {
  const parsed = parseSecuritiesRequest(input);
  if (parsed.tag === "err") {
    return parsed;
  }
  const request = parsed.value;
  const rows = brokers.map((broker) => {
    const calculation =
      broker.reviewAfter <= now ||
      broker.checkedAt > now ||
      (request.mode === "fund" && broker.pointsFrom > now)
        ? unavailable(
            "review_due",
            "公式条件の再確認が必要です。記載情報は参考として残し、試算・順位を保留しています。",
          )
        : request.mode === "fund"
          ? points(broker, request)
          : stock(broker, request);
    const affiliate = affiliates.find(
      (entry) =>
        entry.brokerId === broker.id && entry.approvedUntil > now && entry.creative !== undefined,
    );
    const link =
      affiliate === undefined
        ? ({
            provider: "official",
            url: broker.officialUrl,
            approvedUntil: null,
            creative: null,
          } satisfies SecuritiesComparison["rows"][number]["link"])
        : {
            provider: affiliate.provider,
            url: affiliate.url,
            approvedUntil: affiliate.approvedUntil,
            creative: affiliate.creative ?? null,
          };
    return { ...broker, ...calculation, link, rank: null };
  });
  // Different point programs are not cash-equivalent; points deliberately have no overall ranking.
  const complete = rows.every((row) => row.value !== null);
  return ok({
    generatedAt: now,
    request,
    unit: request.mode === "fund" ? "points" : "JPY",
    rows: rows.map((row) => ({
      ...row,
      rank:
        request.mode !== "stock" || !complete || row.value === null
          ? null
          : 1 +
            rows.filter(
              (other) => other.value !== null && row.value !== null && other.value < row.value,
            ).length,
    })),
    notices: [
      "証券口座のサービス条件の比較です。投資商品の収益や安全性を評価する点数ではありません。",
      "ポイントはプログラムごとに利用先・条件が異なります。円換算や手数料との相殺はしていません。",
      "積立は対象ファンド・本人名義の有効な代表カードを利用し、口座設定や非課税投資枠等の必要条件を満たす場合の参考試算です。",
      "購入手数料と、信託報酬などの保有コストは別です。カード年会費・キャンペーン・保有残高ポイントは試算に含みません。",
    ],
  });
}
