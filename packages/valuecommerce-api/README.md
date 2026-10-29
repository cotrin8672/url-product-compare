# @app/valuecommerce-api

`getAffiliateLink(productId, signal?)` は同じ商品APIのproduct_id指定で1件取得し、商品IDと遷移先guidに対応する成果リンクlinkを返す。productIdはVCのIDであり、さとふるの商品ページ上のproduct_idとは別。Yahoo・さとふるとも同じメソッドを使う。広告スペースの自サイト照合と利用許諾はbackendで別途行う。

[バリューコマース商品API](https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api/)の独立HTTPクライアント。さとふる専用の直接APIではない。backend・比較ロジック・DB・Jev・フレームワークへの依存なし。外部npm依存なし。ESMのJavaScriptと型宣言を `dist/` にビルドするpnpm workspaceパッケージ。

```ts
import { createSatofullClient, createValueCommerceClient } from "@app/valuecommerce-api";

const satofull = createSatofullClient({ token: "PRODUCT_API_TOKEN" });
const result = await satofull.request({ operation: "search", query: "米 10kg", limit: 10 });
const yahoo = createValueCommerceClient({ token: "PRODUCT_API_TOKEN", advertiserCode: "0hzmc" });
```

サーバー用。設定とfetcherを注入でき、環境変数・ファイルは読まない。トークンはサーバーで管理する。`createSatofullClient` は公式広告主コード `jbfh4` を固定するだけで、他の比較処理を含まない。

## 仕様とJSONの形

確認日: 2026-10-17。公式公開仕様と[広告主コード一覧](https://report.valuecommerce.ne.jp/mylink/EC_CODE/list.xls)に基づく。会員限定の提携条件、認証済みの実API応答、`product_id` と `productCode` の実際の対応は未検証。

- 固定送信先: `https://webservice.valuecommerce.ne.jp/productdb/search`。`token / ec_code / format=json / page / results_per_page` を使用。検索は `keyword`、照会は `product_id` を送る。
- `request({operation, query, page?, limit?}, signal?)`。検索語は1〜256文字、照会コードは1〜300文字、ページは1〜1000、件数は1〜50。初期値はpage=1、limit=20。照会時はpage=1のみを受け付ける。
- APIの `{status, resultCount, items}` を `{items, total, page, limit}` に変換。公開する各商品は `ecCode / productCode / title / description / guid / link / price / stock`。`guid` は元の商品URL、`link` は成果リンク。広告主の一致、文字列の型・長さ、正の整数価格、在庫0〜3、配列の大きさを検証する。タイトルは最大256文字、説明は最大4096文字。HTMLを含む説明文の無害化・属性抽出は呼び出し元の責務。
- 数値文字列の価格・在庫は数値へ変換。在庫が未提供・不明ならnull。予約や取り寄せを即納可能と読み替えない。
- `productCode` とURL内のさとふる `product_id` は別物として扱う。ライブラリがURLから照会IDを生成したり、同一商品を保証したりすることはない。
- 戻り値は `tag=ok, value` または `tag=err, error.code`。トークン・設定・検索条件のエラーを分類し、401/403・429・通信失敗・不正JSON・不正フィールドを区別する。生の応答や例外はエラーに含めない。
- HTTPS固定、リダイレクト禁止、8秒タイムアウト、本文1MiB上限、キャンセル対応。問い合わせ先・トークンの別方式へのフォールバックなし。

広告主への提携・表示許可・掲載期限・成果リンクのアカウント照合・対象ドメインの制限・寄付額の扱い・数量換算・比較・保存・AI利用可否はbackendの責務。さとふるのWebページを直接取得しない。

## 利用・ビルド

workspace利用側に `"@app/valuecommerce-api": "workspace:*"` を追加し、公開エントリからimportする。

```text
mise exec -- pnpm --filter @app/valuecommerce-api build
mise exec -- pnpm --filter @app/valuecommerce-api test
```

他プロジェクトへ渡す場合はビルド後、このディレクトリで `pnpm pack` して生成したtgzを利用できる。公開レジストリへのpublishは行っていない。
