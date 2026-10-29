import type { SecuritiesComparison, SecuritiesRequest } from "./securities.js";

export type SecuritiesDraft =
  | Readonly<{
      mode: "fund";
      monthlyYen: number | null;
      annualShoppingYen: number | null;
      monthlyShoppingYen: number | null;
      rakutenFundBand: "low" | "high" | "unknown";
    }>
  | Readonly<{
      mode: "stock";
      account: "nisa" | "taxable";
      tradeYen: number | null;
      orders: number | null;
      sbiElectronicDelivery: boolean;
      rakutenZeroCourse: boolean;
    }>;

export type SecuritiesFormIssue = Readonly<{
  field: "monthlyYen" | "annualShoppingYen" | "monthlyShoppingYen" | "tradeYen" | "orders";
  message: string;
}>;
export type SecuritiesSubmission = Readonly<{
  request: SecuritiesRequest;
  missing: ReadonlyArray<SecuritiesComparison["rows"][number]["id"]>;
}>;

function amountIssue(
  field: SecuritiesFormIssue["field"],
  value: number | null,
  label: string,
  min: number,
  max: number,
  optional = false,
): SecuritiesFormIssue | null {
  if (optional && value === null) {
    return null;
  }
  if (value === null || !Number.isSafeInteger(value) || value < min || value > max) {
    return {
      field,
      message:
        label +
        "は" +
        min.toLocaleString("ja-JP") +
        "〜" +
        max.toLocaleString("ja-JP") +
        "の整数で入力してください。",
    };
  }
  return null;
}

export function prepareSecuritiesSubmission(
  draft: SecuritiesDraft,
):
  | Readonly<{ ok: true; submission: SecuritiesSubmission }>
  | Readonly<{ ok: false; issues: readonly SecuritiesFormIssue[] }> {
  const issues = (
    draft.mode === "fund"
      ? [
          amountIssue("monthlyYen", draft.monthlyYen, "毎月の積立額", 100, 100_000),
          amountIssue(
            "annualShoppingYen",
            draft.annualShoppingYen,
            "SBIの年間カード利用額",
            0,
            100_000_000,
            true,
          ),
          amountIssue(
            "monthlyShoppingYen",
            draft.monthlyShoppingYen,
            "マネックスの月間カード利用額",
            0,
            10_000_000,
            true,
          ),
        ]
      : [
          amountIssue("tradeYen", draft.tradeYen, "1注文の約定金額", 1, 100_000_000),
          amountIssue("orders", draft.orders, "注文数", 1, 1000),
        ]
  ).flatMap((issue) => (issue === null ? [] : [issue]));
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  if (draft.mode === "fund") {
    return {
      ok: true,
      submission: {
        request: {
          mode: "fund",
          monthlyYen: draft.monthlyYen ?? 0,
          annualShoppingYen: draft.annualShoppingYen ?? 0,
          monthlyShoppingYen: draft.monthlyShoppingYen ?? 0,
          rakutenFundBand: draft.rakutenFundBand,
        },
        // Missing inputs use API-compatible placeholders only to retrieve the catalog.
        // The UI must withhold the corresponding calculations and their breakdowns.
        missing: [
          ...(draft.annualShoppingYen === null
            ? (["sbi"] satisfies SecuritiesSubmission["missing"])
            : []),
          ...(draft.monthlyShoppingYen === null
            ? (["monex"] satisfies SecuritiesSubmission["missing"])
            : []),
        ],
      },
    };
  }
  return {
    ok: true,
    submission: {
      request: {
        mode: "stock",
        account: draft.account,
        tradeYen: draft.tradeYen ?? 0,
        orders: draft.orders ?? 0,
        sbiElectronicDelivery: draft.sbiElectronicDelivery,
        rakutenZeroCourse: draft.rakutenZeroCourse,
      },
      missing: [],
    },
  };
}

export function securitiesDraftMatches(
  draft: SecuritiesDraft,
  submission: SecuritiesSubmission,
): boolean {
  const prepared = prepareSecuritiesSubmission(draft);
  if (!prepared.ok) {
    return false;
  }
  const current = prepared.submission.request;
  const previous = submission.request;
  const matches =
    current.mode === "fund" && previous.mode === "fund"
      ? current.monthlyYen === previous.monthlyYen &&
        current.annualShoppingYen === previous.annualShoppingYen &&
        current.monthlyShoppingYen === previous.monthlyShoppingYen &&
        current.rakutenFundBand === previous.rakutenFundBand
      : current.mode === "stock" &&
        previous.mode === "stock" &&
        current.account === previous.account &&
        current.tradeYen === previous.tradeYen &&
        current.orders === previous.orders &&
        current.sbiElectronicDelivery === previous.sbiElectronicDelivery &&
        current.rakutenZeroCourse === previous.rakutenZeroCourse;
  return (
    matches &&
    prepared.submission.missing.length === submission.missing.length &&
    prepared.submission.missing.every((id) => submission.missing.includes(id))
  );
}
