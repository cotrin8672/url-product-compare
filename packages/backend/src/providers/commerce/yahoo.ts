import { createYahooAffiliateId, createYahooShoppingClient } from "@app/yahoo-shopping-api";

import { err, ok } from "../../comparison/algebra.js";
import type { CommerceListing, CommerceProvider } from "../../comparison/commerce.js";
import { record } from "../../comparison/values.js";
import { authorization, cleanDescription, publicUrl, vcLink } from "./transport.js";

export function createYahooShoppingCommerceProvider(
  input: unknown,
  clock: () => string,
  fetcher: typeof fetch = fetch,
): CommerceProvider {
  const rights = authorization(input);
  if (
    !record(input) ||
    typeof input["applicationId"] !== "string" ||
    (input["affiliateId"] !== undefined && typeof input["affiliateId"] !== "string") ||
    typeof input["siteId"] !== "string" ||
    !/^\d{1,20}$/u.test(input["siteId"]) ||
    typeof input["spaceId"] !== "string" ||
    !/^\d{1,20}$/u.test(input["spaceId"]) ||
    input["token"] !== undefined
  ) {
    throw new Error("Invalid Yahoo Shopping API settings");
  }
  const siteId = input["siteId"],
    spaceId = input["spaceId"];
  const client = createYahooShoppingClient(
    {
      applicationId: input["applicationId"],
      affiliateId: input["affiliateId"] ?? createYahooAffiliateId({ siteId, spaceId }),
    },
    fetcher,
  );
  return Object.freeze({
    source: "yahoo",
    async request(query, signal) {
      if (rights.authorizedUntil <= clock()) {
        return err({ code: "source_not_authorized" });
      }
      let key = query.query;
      if (query.operation === "lookup" && key.startsWith("https:")) {
        const url = publicUrl(key, ["store.shopping.yahoo.co.jp"]);
        const match =
          url === null
            ? null
            : /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.%-]+)\.html$/u.exec(url.pathname);
        if (
          match?.[1] === undefined ||
          match[2] === undefined ||
          url?.search !== "" ||
          url.hash !== ""
        ) {
          return err({ code: "invalid_request" });
        }
        key = match[1] + "_" + match[2];
      }
      const response = await client.request(
        { operation: query.operation, query: key, page: query.page, limit: query.limit },
        signal,
      );
      if (response.tag === "err") {
        return response;
      }
      const now = clock();
      if (rights.authorizedUntil <= now) {
        return err({ code: "source_not_authorized" });
      }
      const listings: CommerceListing[] = [];
      for (const item of response.value.items) {
        const url = publicUrl(item.url, ["store.shopping.yahoo.co.jp"]);
        const affiliateUrl = url === null ? null : vcLink(item.affiliateUrl, url, siteId, spaceId);
        if (affiliateUrl === null) {
          return err({ code: "invalid_response" });
        }
        listings.push(
          Object.freeze<CommerceListing>({
            source: "yahoo",
            id: item.code,
            title: item.name,
            url: item.url,
            affiliateUrl,
            description: cleanDescription(item.description),
            imageUrl: item.imageUrl,
            amount: { minimum: item.price, maximum: item.price, currency: "JPY", kind: "purchase" },
            priceBasis: "listing",
            condition: item.condition,
            availability:
              item.inStock === true
                ? "available"
                : item.inStock === false
                  ? "unavailable"
                  : "unknown",
            shipping: item.shippingCode === 2 ? "included" : "unknown",
            tax:
              item.taxIncluded === true
                ? "included"
                : item.taxIncluded === false
                  ? "excluded"
                  : "unknown",
            observedAt: now,
            expiresAt: new Date(
              Math.min(Date.parse(now) + 900000, Date.parse(rights.authorizedUntil)),
            ).toISOString(),
            usage: { ai: rights.ai, priceComparison: true, store: false },
            notices: [
              "寄付商品・型番・容量・商品状態の一致や、配送先別の送料は別途確認が必要です。商品詳細APIで状態を確認できない場合は未確認として扱います。",
            ],
          }),
        );
      }
      return ok(
        Object.freeze({
          listings: Object.freeze(listings),
          total: response.value.total,
          page: response.value.page,
          limit: response.value.limit,
        }),
      );
    },
  });
}
