import { createAmazonClient } from "@app/amazon-api";

import { err, ok } from "../../comparison/algebra.js";
import type { CommerceListing, CommerceProvider } from "../../comparison/commerce.js";
import { record } from "../../comparison/values.js";
import { authorization, publicUrl, stringValue } from "./transport.js";

type Configuration = Readonly<
  Parameters<typeof createAmazonClient>[0] & { authorizedUntil: string }
>;
function configuration(input: unknown): Configuration {
  const rights = authorization(input);
  if (
    !record(input) ||
    typeof input["clientId"] !== "string" ||
    stringValue(input["clientId"], 512) === null ||
    typeof input["clientSecret"] !== "string" ||
    stringValue(input["clientSecret"], 1024) === null ||
    typeof input["partnerTag"] !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}-22$/u.test(input["partnerTag"]) ||
    /[\s\p{Cc}]/u.test(input["clientId"]) ||
    /[\s\p{Cc}]/u.test(input["clientSecret"]) ||
    (input["credentialVersion"] !== undefined &&
      input["credentialVersion"] !== "3.1" &&
      input["credentialVersion"] !== "3.2" &&
      input["credentialVersion"] !== "3.3")
  ) {
    throw new Error("Invalid Amazon Creators API settings");
  }
  return Object.freeze({
    clientId: input["clientId"],
    clientSecret: input["clientSecret"],
    partnerTag: input["partnerTag"],
    authorizedUntil: rights.authorizedUntil,
    ...(input["credentialVersion"] === undefined
      ? {}
      : { credentialVersion: input["credentialVersion"] }),
  });
}
function asin(input: string): string | null {
  if (/^[A-Z0-9]{10}$/u.test(input)) {
    return input;
  }
  const url = publicUrl(input, ["www.amazon.co.jp", "amazon.co.jp"]);
  return url === null
    ? null
    : (/^\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/u.exec(url.pathname)?.[1] ?? null);
}
export function createAmazonCommerceProvider(
  input: unknown,
  clock: () => string,
  fetcher: typeof fetch = fetch,
): CommerceProvider {
  const settings = configuration(input);
  const client = createAmazonClient(settings, fetcher, () => Date.parse(clock()));
  return Object.freeze({
    source: "amazon",
    async request(query, signal) {
      if (settings.authorizedUntil <= clock()) {
        return err({ code: "source_not_authorized" });
      }
      const id = query.operation === "lookup" ? asin(query.query) : null;
      if (query.operation === "lookup" && id === null) {
        return err({ code: "invalid_request" });
      }
      const result = await client.request(
        {
          operation: query.operation,
          query: id ?? query.query,
          page: query.page,
          limit: query.limit,
          includeDetails: false,
        },
        signal,
      );
      if (result.tag === "err") {
        return result;
      }
      const now = clock();
      if (settings.authorizedUntil <= now) {
        return err({ code: "source_not_authorized" });
      }
      const listings = result.value.items.map((item): CommerceListing => {
        const offer = item.offer;
        return Object.freeze<CommerceListing>({
          source: "amazon",
          id: item.asin,
          title: item.title,
          url: "https://www.amazon.co.jp/dp/" + item.asin,
          affiliateUrl: item.detailPageURL,
          description: null,
          imageUrl: item.imageUrl,
          amount:
            offer?.amount === null || offer?.amount === undefined
              ? null
              : { minimum: offer.amount, maximum: offer.amount, currency: "JPY", kind: "purchase" },
          priceBasis: "featured_offer",
          condition:
            offer?.condition === "New"
              ? "new"
              : offer?.condition === "Used"
                ? "used"
                : offer?.condition === "Refurbished"
                  ? "refurbished"
                  : "unknown",
          availability: ["IN_STOCK", "INSTOCK", "INSTOCKSCARCE"].includes(offer?.availability ?? "")
            ? "available"
            : ["OUTOFSTOCK", "UNAVAILABLE"].includes(offer?.availability ?? "")
              ? "unavailable"
              : "unknown",
          shipping: "unknown",
          tax: "unknown",
          observedAt: now,
          expiresAt: new Date(
            Math.min(Date.parse(now) + 900000, Date.parse(settings.authorizedUntil)),
          ).toISOString(),
          usage: { ai: false, priceComparison: false, store: false },
          notices: [
            "おすすめ出品の価格であり、新品・中古の最低価格ではありません。他サイトとの価格比較・採点には使用しません。",
            "価格および在庫状況は表示された日付/時刻の時点のものであり、変更される場合があります。購入時のAmazon.co.jpの価格および在庫状況が適用されます。",
            "本サイト上で表示されるコンテンツの一部は、アマゾンにより提供されたものです。これらのコンテンツは現状有姿で提供されており、随時変更または削除される場合があります。",
          ],
        });
      });
      return ok(
        Object.freeze({
          listings: Object.freeze(listings),
          total: result.value.total,
          page: result.value.page,
          limit: result.value.limit,
        }),
      );
    },
  });
}
