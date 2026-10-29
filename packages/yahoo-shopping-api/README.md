# @app/yahoo-shopping-api

Yahoo!ショッピングの購入者向け公開APIを呼ぶ独立したTypeScript ESMクライアント。出店者用の商品参照・在庫管理APIとは別。backend・画面・DB・キューへの依存なし、外部依存の追加なし。

```ts
import { createYahooAffiliateId, createYahooShoppingClient } from "@app/yahoo-shopping-api";

const affiliateId = createYahooAffiliateId({ siteId, spaceId });
const client = createYahooShoppingClient({ applicationId, affiliateId });
const products = await client.request(
  { operation: "search", query: "保温 ボトル", page: 1, limit: 10, condition: "new" },
  signal,
);
const product = await client.request({ operation: "lookup", query: "shop_item-code" }, signal);
const link = await client.getAffiliateLink("shop_item-code", signal);
```

- 検索は `V3/itemSearch` のJSON。検索語、ページ、件数、任意のJAN・商品状態で絞り込む。1〜50件、start+resultsは1000以下。
- 個別取得は `V1/itemLookup` のXML、`itemcode` と `responsegroup=large`。JSONPやスクリプト実行は使わない。
- 商品コード、名称、説明、画像、商品URL、成果リンク、価格、確認できた商品状態・在庫・送料区分・税込区分を返す。
- affiliateIdを指定すると `affiliate_type=vc` を送信し、応答の追跡URLと商品URLの対応を検証する。`getAffiliateLink` は同じ個別取得APIで発行済みリンクを得る。指定なしなら商品取得のみで、成果リンク取得はエラーとなる。
- affiliateIdは単独のIDではなく、公式手順のVC広告URL（末尾がvc_url=）をURLエンコードする前の文字列。createYahooAffiliateIdは提携済み広告のsid/pidから公式形式のAPIパラメーターを作り、requestが1回だけエンコードする。個別商品の成果リンクはAPI応答から取得する。応答のsid/pidと商品URLも照合する。
- V1詳細の公開仕様には商品状態がないためlookupはunknown。検索時のnewを後のlookupへ流用しない。条件付き送料無料を無条件の送料込みに変えない。
- 通信は8秒・1MiB上限、1.1秒間隔で直列化。キャンセル、リダイレクト拒否、XMLのDTD・外部実体・深すぎる入れ子・項目重複の拒否を実施する。
- 商品データの保存や比較可否・AI利用権の判断はSDKに含めない。

仕様と設定: [調査記録](../../docs/affiliate-api-research-20261017.md)。`mise exec -- pnpm --filter @app/yahoo-shopping-api test` は模擬通信のみ。
