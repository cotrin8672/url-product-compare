import { createSatofullClient, createValueCommerceClient } from "@app/valuecommerce-api";

import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import type {
  CommerceError,
  CommerceListing,
  CommerceProvider,
} from "../../comparison/commerce.js";
import { record } from "../../comparison/values.js";
import {
  authorization,
  cleanDescription,
  natural,
  publicUrl,
  stringValue,
  vcLink,
} from "./transport.js";

type Configuration = Readonly<{ token: string; siteId: string; spaceId: string; ai: boolean }>;

function configuration(input: unknown): Configuration {
  const rights = authorization(input);
  if (
    !record(input) ||
    stringValue(input["token"], 256) === null ||
    typeof input["token"] !== "string" ||
    /[\s\p{Cc}]/u.test(input["token"]) ||
    typeof input["siteId"] !== "string" ||
    !/^\d{1,20}$/.test(input["siteId"]) ||
    typeof input["spaceId"] !== "string" ||
    !/^\d{1,20}$/.test(input["spaceId"])
  ) {
    throw new Error("Invalid ValueCommerce settings");
  }
  return Object.freeze({
    token: input["token"],
    siteId: input["siteId"],
    spaceId: input["spaceId"],
    ...rights,
  });
}

function destination(input: unknown, source: "yahoo" | "satofull"): URL | null {
  const url = publicUrl(
    input,
    source === "satofull" ? ["www.satofull.jp"] : ["store.shopping.yahoo.co.jp"],
  );
  if (url === null) {
    return null;
  }
  const valid =
    source === "satofull"
      ? url.pathname === "/products/detail.php" &&
        url.searchParams.getAll("product_id").length === 1 &&
        /^\d{1,20}$/.test(url.searchParams.get("product_id") ?? "")
      : /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.%-]+\.html$/.test(url.pathname);
  return valid ? url : null;
}

function parseListing(
  raw: unknown,
  source: "yahoo" | "satofull",
  settings: Configuration,
  now: string,
): Result<CommerceListing, CommerceError> {
  if (!record(raw) || raw["ecCode"] !== (source === "satofull" ? "jbfh4" : "0hzmc")) {
    return err({ code: "invalid_response" });
  }
  const url = destination(raw["guid"], source);
  const title = stringValue(raw["title"], 2000);
  const amount = natural(raw["price"]);
  const id = stringValue(raw["productCode"], 300);
  if (url === null || title === null || amount === null || id === null || amount === 0) {
    return err({ code: "invalid_response" });
  }
  const affiliate = vcLink(raw["link"], url, settings.siteId, settings.spaceId);
  if (affiliate === null) {
    return err({ code: "invalid_response" });
  }
  const description = cleanDescription(raw["description"], 4096);
  if (raw["description"] !== undefined && raw["description"] !== null && description === null) {
    return err({ code: "invalid_response" });
  }
  return ok(
    Object.freeze({
      source,
      id,
      title,
      url: url.href,
      affiliateUrl: affiliate,
      description,
      imageUrl: typeof raw["imageUrl"] === "string" ? raw["imageUrl"] : null,
      amount: Object.freeze({
        minimum: amount,
        maximum: amount,
        currency: "JPY",
        kind: source === "satofull" ? "donation" : "purchase",
      }),
      priceBasis: "listing",
      condition: source === "satofull" ? "not_applicable" : "unknown",
      availability:
        raw["stock"] === "1" || raw["stock"] === 1
          ? "available"
          : raw["stock"] === "0" || raw["stock"] === 0
            ? "unavailable"
            : "unknown",
      shipping: "unknown",
      tax: source === "satofull" ? "included" : "unknown",
      observedAt: now,
      expiresAt: new Date(Date.parse(now) + 900_000).toISOString(),
      usage: Object.freeze({ ai: settings.ai, priceComparison: true, store: false }),
      notices: Object.freeze([
        source === "satofull"
          ? "返礼品の寄付額です。内容量・回数・配送条件が同じかは未確認です。"
          : "商品状態・税込み総額・配送先別送料は未確認です。新品限定の比較にはまだ採用できません。",
      ]),
    }),
  );
}

export function createValueCommerceProvider(
  source: "yahoo" | "satofull",
  input: unknown,
  clock: () => string,
  fetcher: typeof fetch = fetch,
): CommerceProvider {
  const settings = configuration(input);
  const client =
    source === "satofull"
      ? createSatofullClient(settings, fetcher)
      : createValueCommerceClient({ token: settings.token, advertiserCode: "0hzmc" }, fetcher);
  return Object.freeze({
    source,
    async request(query, signal) {
      if (
        query.query.length > (query.operation === "lookup" ? 300 : 256) ||
        (query.operation === "lookup" && /[\s/?#]/u.test(query.query))
      ) {
        return err({ code: "invalid_request" });
      }
      const result = await client.request(
        {
          operation: query.operation,
          query: query.query,
          page: query.page,
          limit: query.operation === "lookup" ? 1 : query.limit,
        },
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      const { items, total } = result.value;
      const listings: CommerceListing[] = [];
      const now = clock();
      const ids = new Set<string>();
      for (const item of items) {
        const parsed = parseListing(item, source, settings, now);
        if (parsed.tag === "err") {
          return parsed;
        }
        if (
          ids.has(parsed.value.id) ||
          (query.operation === "lookup" && parsed.value.id !== query.query)
        ) {
          return err({ code: "invalid_response" });
        }
        ids.add(parsed.value.id);
        listings.push(parsed.value);
      }
      if (query.operation === "lookup" && listings.length === 0) {
        return err({ code: "listing_not_found" });
      }
      return ok(
        Object.freeze({
          listings: Object.freeze(listings),
          total,
          page: query.page,
          limit: query.operation === "lookup" ? 1 : query.limit,
        }),
      );
    },
  });
}
