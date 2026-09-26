export type Investigation = Readonly<{
  mode: "demo";
  notice: string;
  provider: string;
  listingId: string;
  productId: string;
  title: string;
  canonicalUrl: string;
  matchMethod: string;
  observedAt: string;
}>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function parseInvestigation(input: unknown): Investigation {
  if (!record(input)) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  if (input["tag"] === "err") {
    throw new Error("このURLの商品はデモで確認できません");
  }
  const value = input["value"];
  if (
    input["tag"] !== "ok" ||
    !record(value) ||
    value["mode"] !== "demo" ||
    typeof value["notice"] !== "string" ||
    typeof value["provider"] !== "string" ||
    typeof value["listingId"] !== "string" ||
    typeof value["productId"] !== "string" ||
    typeof value["title"] !== "string" ||
    typeof value["canonicalUrl"] !== "string" ||
    typeof value["matchMethod"] !== "string" ||
    typeof value["observedAt"] !== "string" ||
    !URL.canParse(value["canonicalUrl"]) ||
    new URL(value["canonicalUrl"]).protocol !== "https:" ||
    !Number.isFinite(Date.parse(value["observedAt"]))
  ) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  return {
    mode: "demo",
    notice: value["notice"],
    provider: value["provider"],
    listingId: value["listingId"],
    productId: value["productId"],
    title: value["title"],
    canonicalUrl: value["canonicalUrl"],
    matchMethod: value["matchMethod"],
    observedAt: value["observedAt"],
  } satisfies Investigation;
}

export async function investigateProduct(url: string): Promise<Investigation> {
  const response = await fetch(`/api/investigate?url=${encodeURIComponent(url)}`);
  const body: unknown = await response.json();
  return parseInvestigation(body);
}
