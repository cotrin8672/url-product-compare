import { authHeaders, readJsonResponse, resolveApiBase } from "./consumer-http.js";
import type { ApiRequestOptions } from "./consumer-http.js";

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
type BrokerId = "sbi" | "rakuten" | "monex";
export type SecuritiesComparison = Readonly<{
  generatedAt: string;
  request: SecuritiesRequest;
  unit: "JPY" | "points";
  rows: ReadonlyArray<
    Readonly<{
      id: BrokerId;
      name: string;
      officialUrl: string;
      checkedAt: string;
      reviewAfter: string;
      pointsFrom: string;
      card: string;
      minimumCardYen: number;
      pointName: string;
      notes: readonly string[];
      sources: ReadonlyArray<Readonly<{ label: string; url: string }>>;
      value: number | null;
      status: "calculated" | "needs_information" | "out_of_scope" | "review_due";
      reason: string;
      breakdown: ReadonlyArray<Readonly<{ label: string; value: number }>>;
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

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function invalid(): Error {
  return new Error("証券比較の応答を検証できませんでした。再取得してください。");
}
function text(input: unknown, max = 1024): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > max ||
    /\p{Cc}/u.test(input)
  ) {
    throw invalid();
  }
  return input;
}
function number(input: unknown, max = 100_000_000_000): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > max) {
    throw invalid();
  }
  return input;
}
function integer(input: unknown, min: number, max: number): number {
  const value = number(input, max);
  if (!Number.isSafeInteger(value) || value < min) {
    throw invalid();
  }
  return value;
}
function instant(input: unknown): string {
  const value = text(input, 24);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid();
  }
  return value;
}
function strings(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 20) {
    throw invalid();
  }
  const entries: readonly unknown[] = input;
  return entries.map((entry) => text(entry));
}
function https(input: unknown, hosts: readonly string[]): string {
  const url = new URL(text(input, 2048));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !hosts.includes(url.hostname)
  ) {
    throw invalid();
  }
  return url.href;
}
function request(input: unknown): SecuritiesRequest {
  if (!record(input)) {
    throw invalid();
  }
  if (
    input["mode"] === "fund" &&
    Object.keys(input).length === 5 &&
    (input["rakutenFundBand"] === "low" ||
      input["rakutenFundBand"] === "high" ||
      input["rakutenFundBand"] === "unknown")
  ) {
    return {
      mode: "fund",
      monthlyYen: integer(input["monthlyYen"], 100, 100_000),
      monthlyShoppingYen: integer(input["monthlyShoppingYen"], 0, 10_000_000),
      annualShoppingYen: integer(input["annualShoppingYen"], 0, 100_000_000),
      rakutenFundBand: input["rakutenFundBand"],
    };
  }
  if (
    input["mode"] === "stock" &&
    Object.keys(input).length === 6 &&
    (input["account"] === "nisa" || input["account"] === "taxable") &&
    typeof input["sbiElectronicDelivery"] === "boolean" &&
    typeof input["rakutenZeroCourse"] === "boolean"
  ) {
    return {
      mode: "stock",
      account: input["account"],
      tradeYen: integer(input["tradeYen"], 1, 100_000_000),
      orders: integer(input["orders"], 1, 1000),
      sbiElectronicDelivery: input["sbiElectronicDelivery"],
      rakutenZeroCourse: input["rakutenZeroCourse"],
    };
  }
  throw invalid();
}

function parseRow(
  input: unknown,
  expected: SecuritiesRequest,
  now: string,
): SecuritiesComparison["rows"][number] {
  if (
    !record(input) ||
    (input["id"] !== "sbi" && input["id"] !== "rakuten" && input["id"] !== "monex") ||
    !record(input["link"]) ||
    !Array.isArray(input["sources"]) ||
    input["sources"].length === 0 ||
    input["sources"].length > 10 ||
    !Array.isArray(input["breakdown"]) ||
    input["breakdown"].length > 10
  ) {
    throw invalid();
  }
  const id = input["id"];
  const officialHosts =
    id === "sbi"
      ? ["www.sbisec.co.jp", "www.smbc-card.com"]
      : id === "rakuten"
        ? ["www.rakuten-sec.co.jp"]
        : ["info.monex.co.jp"];
  const officialUrl = https(input["officialUrl"], [officialHosts[0] ?? ""]);
  const rawLink = input["link"];
  const provider = rawLink["provider"];
  if (provider !== "official" && provider !== "valuecommerce" && provider !== "accesstrade") {
    throw invalid();
  }
  const url = https(
    rawLink["url"],
    provider === "official"
      ? [officialHosts[0] ?? ""]
      : provider === "valuecommerce"
        ? ["ck.jp.ap.valuecommerce.com"]
        : ["h.accesstrade.net"],
  );
  const approvedUntil =
    rawLink["approvedUntil"] === null ? null : instant(rawLink["approvedUntil"]);
  const rawCreative = rawLink["creative"];
  let creative: SecuritiesComparison["rows"][number]["link"]["creative"] = null;
  if (rawCreative !== null && rawCreative !== undefined) {
    if (!record(rawCreative)) {
      throw invalid();
    }
    const impressionUrl =
      rawCreative["impressionUrl"] === null
        ? null
        : https(
            rawCreative["impressionUrl"],
            provider === "accesstrade" ? ["h.accesstrade.net"] : ["ad.jp.ap.valuecommerce.com"],
          );
    const label = text(rawCreative["text"], 256);
    if (
      /[<>]/u.test(label) ||
      provider === "official" ||
      (provider === "valuecommerce" && impressionUrl === null)
    ) {
      throw invalid();
    }
    creative = { text: label, impressionUrl };
    const destination = new URL(url);
    const impression = impressionUrl === null ? null : new URL(impressionUrl);
    if (
      provider === "accesstrade"
        ? destination.pathname !== "/sp/cc" ||
          destination.searchParams.getAll("rk").length !== 1 ||
          !/^[a-zA-Z0-9_-]+$/u.test(destination.searchParams.get("rk") ?? "") ||
          (impression !== null &&
            (impression.pathname !== "/sp/rr" ||
              impression.searchParams.getAll("rk").length !== 1 ||
              impression.searchParams.get("rk") !== destination.searchParams.get("rk")))
        : destination.pathname !== "/servlet/referral" ||
          destination.searchParams.getAll("sid").length !== 1 ||
          destination.searchParams.getAll("pid").length !== 1 ||
          !/^\d+$/u.test(destination.searchParams.get("sid") ?? "") ||
          !/^\d+$/u.test(destination.searchParams.get("pid") ?? "") ||
          impression?.pathname !== "/servlet/gifbanner" ||
          impression.searchParams.getAll("sid").length !== 1 ||
          impression.searchParams.getAll("pid").length !== 1 ||
          impression.searchParams.get("sid") !== destination.searchParams.get("sid") ||
          impression.searchParams.get("pid") !== destination.searchParams.get("pid")
    ) {
      throw invalid();
    }
  }
  if (
    provider === "official"
      ? approvedUntil !== null || url !== officialUrl
      : approvedUntil === null || approvedUntil <= now || creative === null
  ) {
    throw invalid();
  }
  const checkedAt = instant(input["checkedAt"]),
    reviewAfter = instant(input["reviewAfter"]),
    pointsFrom = instant(input["pointsFrom"]);
  if (reviewAfter <= checkedAt) {
    throw invalid();
  }
  const status = input["status"];
  if (
    status !== "calculated" &&
    status !== "needs_information" &&
    status !== "out_of_scope" &&
    status !== "review_due"
  ) {
    throw invalid();
  }
  const value = input["value"] === null ? null : number(input["value"]);
  const rank = input["rank"] === null ? null : integer(input["rank"], 1, 3);
  const rawBreakdown: readonly unknown[] = input["breakdown"];
  const breakdown = rawBreakdown.map((entry) => {
    if (!record(entry)) {
      throw invalid();
    }
    return { label: text(entry["label"]), value: number(entry["value"]) };
  });
  if (
    (status === "calculated") !== (value !== null) ||
    (value === null && (breakdown.length !== 0 || rank !== null)) ||
    (expected.mode === "fund" && rank !== null)
  ) {
    throw invalid();
  }
  if (status === "calculated") {
    if (checkedAt > now || reviewAfter <= now || (expected.mode === "fund" && pointsFrom > now)) {
      throw invalid();
    }
    const computed =
      expected.mode === "fund"
        ? breakdown.reduce((sum, entry) => sum + entry.value, 0)
        : (breakdown[0]?.value ?? -1) * expected.orders;
    if (
      value === null ||
      Math.abs(computed - value) > 0.00001 ||
      (expected.mode === "stock" &&
        (breakdown.length !== 2 || breakdown[1]?.value !== expected.orders))
    ) {
      throw invalid();
    }
  }
  const rawSources: readonly unknown[] = input["sources"];
  const sources = rawSources.map((entry) => {
    if (!record(entry)) {
      throw invalid();
    }
    return { label: text(entry["label"]), url: https(entry["url"], officialHosts) };
  });
  return {
    id,
    name: text(input["name"], 100),
    officialUrl,
    checkedAt,
    reviewAfter,
    pointsFrom,
    card: text(input["card"]),
    minimumCardYen: integer(input["minimumCardYen"], 1, 100_000),
    pointName: text(input["pointName"]),
    notes: strings(input["notes"]),
    sources,
    value,
    status,
    reason: text(input["reason"]),
    breakdown,
    rank,
    link: { url, provider, approvedUntil, creative },
  };
}

export function parseSecuritiesComparison(
  input: unknown,
  expected?: SecuritiesRequest,
  now = new Date().toISOString(),
): SecuritiesComparison {
  if (!record(input) || input["tag"] !== "ok" || !record(input["value"])) {
    throw invalid();
  }
  const data = input["value"];
  const parsedRequest = request(data["request"]);
  if (
    expected !== undefined &&
    JSON.stringify(parsedRequest) !== JSON.stringify(request(expected))
  ) {
    throw invalid();
  }
  const generatedAt = instant(data["generatedAt"]);
  if (
    Math.abs(Date.parse(generatedAt) - Date.parse(now)) > 300_000 ||
    !Array.isArray(data["rows"]) ||
    data["rows"].length !== 3 ||
    data["unit"] !== (parsedRequest.mode === "fund" ? "points" : "JPY")
  ) {
    throw invalid();
  }
  const entries: readonly unknown[] = data["rows"];
  const rows = entries.map((entry) => parseRow(entry, parsedRequest, now));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw invalid();
  }
  for (const row of rows) {
    if (rows.some((entry) => entry.value === null) && row.rank !== null) {
      throw invalid();
    }
    if (
      parsedRequest.mode === "stock" &&
      row.value !== null &&
      rows.every((entry) => entry.value !== null) &&
      row.rank !==
        1 +
          rows.filter(
            (other) => other.value !== null && row.value !== null && other.value < row.value,
          ).length
    ) {
      throw invalid();
    }
  }
  return {
    generatedAt,
    request: parsedRequest,
    unit: parsedRequest.mode === "fund" ? "points" : "JPY",
    rows,
    notices: strings(data["notices"]),
  };
}

export async function fetchSecuritiesComparison(
  input?: SecuritiesRequest,
  options: ApiRequestOptions = {},
): Promise<SecuritiesComparison> {
  const checked = input === undefined ? undefined : request(input);
  const deadline = AbortSignal.timeout(15_000);
  const response = await fetch(`${resolveApiBase(options.apiBase)}/api/securities`, {
    method: checked === undefined ? "GET" : "POST",
    headers: authHeaders(options),
    ...(checked === undefined ? {} : { body: JSON.stringify(checked) }),
    signal: options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]),
  });
  return parseSecuritiesComparison(await readJsonResponse(response), checked);
}
