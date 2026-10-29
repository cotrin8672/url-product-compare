# @app/rakuten-api

`getAffiliateLink(itemCode, signal?)` は商品検索APIのitemCode指定で1件取得し、応答のaffiliateUrlを返す。商品コード・遷移先itemUrl・自分のaffiliateIdを検証し、リンクを推測で合成しない。楽天市場と楽天ふるさと納税の両方で利用できる。

楽天ウェブサービスのHTTPクライアント。backend・比較ロジック・DB・Jev・フレームワークへの依存なし。外部npm依存なし。ESMのJavaScriptと型宣言を `dist/` にビルドするpnpm workspaceパッケージ。

```ts
import { createRakutenClient } from "@app/rakuten-api";

const client = createRakutenClient({
  applicationId: "APPLICATION_ID",
  accessKey: "ACCESS_KEY",
  affiliateId: "AFFILIATE_ID",
  allowedOrigin: "https://example.com",
});
const result = await client.searchItems({ keyword: "ふるさと納税 米", hits: 10 });
if (result.tag === "ok") {
  // result.value.count / result.value.items
}
```

サーバー用。認証情報をブラウザーへ渡さない。設定は呼び出し元から渡し、環境変数・ファイルはライブラリから読まない。第2引数に `typeof fetch` を注入できる。

## 対応APIとJSONの形

確認日: 2026-10-17。公式公開仕様を参照。認証済みの実API応答は未検証。

- `searchItems(input, signal?)`: [商品検索API 20260701](https://webservice.rakuten.co.jp/documentation/ichiba-item-search)。`applicationId / affiliateId / format=json / formatVersion=2` をクエリ、`accessKey / Origin` をヘッダーに設定。検索語・ショップ・ジャンル・itemCode・件数・ページ・除外語・取得フィールドを指定できる。専用のふるさと納税APIではなく、検索語や採用判定は呼び出し元が決める。
- 入力は `keyword / shopCode / genreId / itemCode` のいずれか、hitsは1〜30、pageは1〜100。公開仕様の `items` と従来の `Items` を `items` に正規化し、`{count, items}` を返す。両方ある曖昧な応答は拒否する。
- 商品の各要素は `Readonly<Record<string, unknown>>`。JSONオブジェクトであることまでを検証する。任意の `elements` を許すため、常に価格や説明文が含まれる型にはしていない。`itemName / itemCaption / itemUrl / affiliateUrl / itemPriceMin1...3 / itemPriceMax1...3` 等の業務上必要なフィールドは呼び出し元で検証する。
- `genre(genreId, signal?)`: [ジャンル検索API 20260701](https://webservice.rakuten.co.jp/documentation/ichiba-genre-search)。`genre / ancestors / attributes` のJSONオブジェクトを返す。
- `searchProducts({productCode?, keyword?, hits?}, signal?, timeoutMs?)`: [商品価格ナビ製品検索API 20250801](https://webservice.rakuten.co.jp/documentation/ichiba-product-search)。`Products` の各オブジェクトを配列で返す。製品の同定や仕様推測は行わない。任意のtimeoutMsは1〜8,000msで、処理全体の残り時間を渡せる。タイムアウトとキャンセルの合成はライブラリで一度だけ行う。
- JANの `productCode` とkeywordの同時指定は拒否する。JAN照会では公式仕様に従いhits等のサービス固有パラメーターを送らず、指定hitsは応答配列の内部上限としてのみ使う。

戻り値は `tag=ok, value` または `tag=err, error.code`。認証失敗・429・404・通信失敗・不正応答・サイズ超過を区別し、認証情報や生の例外は返さない。同じ設定オブジェクト・fetcherの全操作で1.1秒間隔を共有する。商品検索のみ一時的な通信失敗・502/503/504を1回再試行。リダイレクト禁止、レスポンスは最大1MiB（ジャンル256KiB）、タイムアウトは8秒（ジャンル5秒）。本文読取とキュー待ちもキャンセルできる。

アフィリエイトリンクの掲載可否・契約期限・商品状態・税込み総額・比較判定・保存・採点はbackendの責務。ライブラリは個別商品URLへアクセスしない。

## 利用・ビルド

workspace利用側に `"@app/rakuten-api": "workspace:*"` を追加し、公開エントリだけをimportする。

```text
mise exec -- pnpm --filter @app/rakuten-api build
mise exec -- pnpm --filter @app/rakuten-api test
```

他プロジェクトへ渡す場合はビルド後、このディレクトリで `pnpm pack` して生成したtgzを利用できる。公開レジストリへのpublishは行っていない。
