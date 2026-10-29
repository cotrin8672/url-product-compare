import type { SecuritiesBroker } from "../../comparison/securities.js";

// Reviewed official-source snapshot, not a live ASP feed. Recheck before advancing reviewAfter.
export const securitiesCatalog: readonly SecuritiesBroker[] = [
  {
    id: "sbi",
    name: "SBI証券",
    officialUrl: "https://www.sbisec.co.jp/",
    checkedAt: "2026-10-25T00:00:00.000Z",
    reviewAfter: "2026-10-26T00:00:00.000Z",
    pointsFrom: "2024-11-01T00:00:00.000Z",
    card: "三井住友カード（NL）・入会2年目以降",
    minimumCardYen: 100,
    pointName: "Vポイント",
    stockFees: [],
    sources: [
      {
        label: "国内株式ゼロ革命の条件",
        url: "https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=info&dir=info&file=home_info_zerocom.html&getFlg=on",
      },
      {
        label: "一般カードの積立ポイント条件",
        url: "https://www.smbc-card.com/nyukai/merit/tsumitate_details_classic.jsp",
      },
      {
        label: "クレカ積立の利用条件",
        url: "https://www.smbc-card.com/mem/for_sbi/tsumitate/index.jsp",
      },
    ],
    notes: [
      "国内株の無料条件はインターネットコース（プランC含む）・インターネット取引・所定の電子交付設定。",
      "ポイント判定の年間利用額に投信積立は含みません。入会初年度や集計期間の特例は試算対象外です。",
    ],
  },
  {
    id: "rakuten",
    name: "楽天証券",
    officialUrl: "https://www.rakuten-sec.co.jp/",
    checkedAt: "2026-10-25T00:00:00.000Z",
    reviewAfter: "2026-10-26T00:00:00.000Z",
    pointsFrom: "2026-10-25T00:00:00.000Z",
    card: "楽天カード（一般）",
    minimumCardYen: 100,
    pointName: "楽天ポイント",
    stockFees: [],
    sources: [
      {
        label: "国内株式の手数料コース",
        url: "https://www.rakuten-sec.co.jp/smartphone/commission/",
      },
      { label: "NISAの取引ルール", url: "https://www.rakuten-sec.co.jp/web/nisa/rule/" },
      {
        label: "楽天カード積立の条件",
        url: "https://www.rakuten-sec.co.jp/web/rfund/guide/creditcard.html",
      },
    ],
    notes: [
      "課税口座の無料試算はゼロコース・SOR（Rクロス含む）の利用同意が前提です。",
      "代行手数料は信託報酬全体とは異なります。公式の判定基準日の区分を指定してください。",
      "ゴールド・プレミアム・ブラック・みずほ提携等のカードは今回の試算対象外です。",
    ],
  },
  {
    id: "monex",
    name: "マネックス証券",
    officialUrl: "https://info.monex.co.jp/",
    checkedAt: "2026-10-25T00:00:00.000Z",
    reviewAfter: "2026-10-26T00:00:00.000Z",
    pointsFrom: "2026-10-01T00:00:00.000Z",
    card: "マネックスカード",
    minimumCardYen: 1000,
    pointName: "マネックスポイント",
    stockFees: [
      { throughYen: 50_000, feeYen: 55 },
      { throughYen: 100_000, feeYen: 99 },
      { throughYen: 200_000, feeYen: 115 },
      { throughYen: 500_000, feeYen: 275 },
      { throughYen: 1_000_000, feeYen: 535 },
      { throughYen: 1_500_000, feeYen: 640 },
      { throughYen: 30_000_000, feeYen: 1013 },
      { throughYen: 100_000_000, feeYen: 1070 },
    ],
    sources: [
      { label: "国内現物・取引毎手数料", url: "https://info.monex.co.jp/stock/fee.html" },
      { label: "NISAの手数料と費用", url: "https://info.monex.co.jp/nisa/fee.html" },
      {
        label: "マネックスカード積立の条件",
        url: "https://info.monex.co.jp/fund/tsumitate/card-tsumitate/monex-card/about.html",
      },
    ],
    notes: [
      "2026年10月買付分から、積立以外の対象ショッピング利用額で付与条件が変わります。",
      "月1万円未満の対象ショッピング利用は0%。月1万〜5万円未満は段階別通常率の半分、5万円以上は通常率で試算します。",
      "原則1,000円以上ですが対象外・最低額が異なるファンドがあります。dカード・JCBカードは今回の試算対象外です。",
    ],
  },
] satisfies readonly SecuritiesBroker[];
