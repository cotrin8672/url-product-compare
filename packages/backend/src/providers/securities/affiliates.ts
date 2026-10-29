import type { SecuritiesAffiliate } from "../../comparison/securities.js";
import { record } from "../../comparison/values.js";

export function securitiesAffiliates(input: unknown): readonly SecuritiesAffiliate[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input) || input.length > 3) {
    throw new Error("Invalid securities affiliate configuration");
  }
  const entries: readonly unknown[] = input;
  const result = entries.map((entry): SecuritiesAffiliate => {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) =>
          !["brokerId", "provider", "programId", "url", "approvedUntil", "creative"].includes(key),
      ) ||
      (entry["brokerId"] !== "sbi" &&
        entry["brokerId"] !== "rakuten" &&
        entry["brokerId"] !== "monex") ||
      (entry["provider"] !== "valuecommerce" && entry["provider"] !== "accesstrade") ||
      typeof entry["programId"] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(entry["programId"]) ||
      typeof entry["url"] !== "string" ||
      entry["url"].length > 2048 ||
      typeof entry["approvedUntil"] !== "string" ||
      !Number.isFinite(Date.parse(entry["approvedUntil"])) ||
      new Date(entry["approvedUntil"]).toISOString() !== entry["approvedUntil"]
    ) {
      throw new Error("Invalid securities affiliate configuration");
    }
    const url = new URL(entry["url"]);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== "" ||
      (entry["provider"] === "valuecommerce"
        ? url.hostname !== "ck.jp.ap.valuecommerce.com" ||
          url.pathname !== "/servlet/referral" ||
          url.searchParams.getAll("sid").length !== 1 ||
          url.searchParams.getAll("pid").length !== 1 ||
          !/^\d+$/.test(url.searchParams.get("sid") ?? "") ||
          !/^\d+$/.test(url.searchParams.get("pid") ?? "")
        : url.hostname !== "h.accesstrade.net" ||
          url.pathname !== "/sp/cc" ||
          url.searchParams.getAll("rk").length !== 1 ||
          !/^[a-zA-Z0-9_-]+$/.test(url.searchParams.get("rk") ?? ""))
    ) {
      throw new Error("Invalid securities affiliate URL");
    }
    const rawCreative = entry["creative"];
    let creative: SecuritiesAffiliate["creative"];
    if (rawCreative !== undefined) {
      if (
        !record(rawCreative) ||
        Object.keys(rawCreative).length !== 2 ||
        typeof rawCreative["text"] !== "string" ||
        rawCreative["text"].trim().length === 0 ||
        rawCreative["text"].length > 256 ||
        /[\p{Cc}<>]/u.test(rawCreative["text"]) ||
        (rawCreative["impressionUrl"] !== null && typeof rawCreative["impressionUrl"] !== "string")
      ) {
        throw new Error("Invalid securities affiliate creative");
      }
      const impression =
        rawCreative["impressionUrl"] === null ? null : new URL(rawCreative["impressionUrl"]);
      if (
        impression !== null &&
        (impression.protocol !== "https:" ||
          impression.username !== "" ||
          impression.password !== "" ||
          impression.port !== "" ||
          impression.hash !== "" ||
          impression.href.length > 2048 ||
          (entry["provider"] === "accesstrade"
            ? impression.hostname !== "h.accesstrade.net" ||
              impression.pathname !== "/sp/rr" ||
              impression.searchParams.getAll("rk").length !== 1 ||
              impression.searchParams.get("rk") !== url.searchParams.get("rk")
            : impression.hostname !== "ad.jp.ap.valuecommerce.com" ||
              impression.pathname !== "/servlet/gifbanner" ||
              impression.searchParams.getAll("sid").length !== 1 ||
              impression.searchParams.getAll("pid").length !== 1 ||
              impression.searchParams.get("sid") !== url.searchParams.get("sid") ||
              impression.searchParams.get("pid") !== url.searchParams.get("pid")))
      ) {
        throw new Error("Invalid securities affiliate impression");
      }
      if (entry["provider"] === "valuecommerce" && impression === null) {
        throw new Error("ValueCommerce requires an impression tag");
      }
      creative = { text: rawCreative["text"], impressionUrl: impression?.href ?? null };
    }
    return {
      brokerId: entry["brokerId"],
      provider: entry["provider"],
      programId: entry["programId"],
      approvedUntil: entry["approvedUntil"],
      url: url.href,
      ...(creative === undefined ? {} : { creative }),
    };
  });
  if (new Set(result.map((entry) => entry.brokerId)).size !== result.length) {
    throw new Error("Duplicate securities affiliate");
  }
  return result;
}
