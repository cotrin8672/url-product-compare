# @app/amazon-api

Amazon Creators APIの独立したTypeScript ESMクライアント。backend・画面・DB・キューに依存せず、追加の外部依存も不要。

```ts
import { createAmazonClient } from "@app/amazon-api";

const client = createAmazonClient({ clientId, clientSecret, partnerTag, credentialVersion: "3.3" });
const products = await client.request(
  { operation: "search", query: "保温 ボトル", page: 1, limit: 10 },
  signal,
);
const product = await client.request({ operation: "lookup", query: asin }, signal);
const link = await client.getAffiliateLink(asin, signal);
const batch = await client.getItems([asin], signal);
const variants = await client.getVariations(parentAsin, 1, 10, signal);
```

- 日本市場。OAuthトークン取得先は認証情報のバージョンで選択（3.1=米国、3.2=英国、3.3=日本、未指定3.3）。APIは `creatorsapi.amazon/catalog/v1`、marketplaceは `www.amazon.co.jp`。
- 結果は `{ tag: "ok", value }` / `{ tag: "err", error: { code } }`。検索は1〜10ページ・1〜10件、一括取得は重複のないASINを1〜10件。
- 商品名、画像URL、features、parentASIN、おすすめ出品の価格・状態・在庫を返す。SDKは説明の生成・比較・採点をしない。アプリの既存アダプターは `includeDetails: false` で説明取得を抑止する。
- 成果リンクはGetItemsのdetailPageURLをそのまま返す。ASIN、日本市場、自分のpartnerTagを検証する。別のリンク生成APIやHTML取得は使用しない。
- MAP制限がある、制限が不明、JPYの確定整数価格ではない場合は価格null。おすすめ出品を最安値と呼ばない。
- 短命トークンだけメモリに保持し、商品データは保存しない。認証拒否後はトークンを破棄。8秒の各通信上限、全体15秒、1MiBの応答上限、中断とリダイレクト拒否を適用する。
- 利用許諾・表示期限・比較への採用・広告表記は呼び出し元が判断する。APIアクセス権・追跡タグ・申請は利用者側で用意する。

仕様と制約: [調査記録](../../docs/affiliate-api-research-20261017.md)。`mise exec -- pnpm --filter @app/amazon-api test` は模擬通信のみ。
