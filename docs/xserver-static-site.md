# Xserver 向け静的フロントエンド

API・比較ワーカーをLambda、永続データをDynamoDBに置く構成の手順は [Xserver＋Lambda](../infrastructure/lambda/README.md) を参照してください。Xserverには静的ファイルだけを配置します。

AstroのSSGで公開HTML・CSS・ブラウザー用JavaScriptを `apps/products/dist/` に生成します。比較画面は既存のSolid/TypeScriptをそのまま起動し、比較データの取得は既存APIクライアントへ委譲します。Xserver側でPHP、Node.js、Astroの実行環境は不要です。ふるさと納税の画面・ロジックは今回の移植対象外として既存の入口を維持しています。この作業ではデプロイを行っていません。

## 生成と接続先

本番環境変数を設定し、ルートから実行します。

```powershell
rtk mise exec -- node tooling/build-site.mjs
```

`tooling/prepare-site.mjs` はコンパイル済み `publicConsumerCatalog()` から公開メタデータを生成します。カテゴリや評価軸の代替表はありません。AstroページがこのデータからHTMLを生成し、`tooling/build-site.mjs` が固有タイトル・見出し・スコアラベル・canonical・公開ルート・sitemap・アセット参照・実行可能なインラインスクリプトの不在を検証します。生成データはGit管理外で、dev/build/型検査の前に再生成します。外部の商品APIはビルド時に呼びません。

| 環境変数          | 内容                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ORIGIN`     | 公開HTTPSオリジン。資格情報・クエリ・フラグメント・パスは不可。空ならnoindexにし、canonicalとsitemapを出しません。localhost・IPは拒否します。 |
| `PUBLIC_API_BASE` | 公開ゲートウェイのHTTPS URLプレフィックス。資格情報・クエリ・フラグメント・ローカル接続先は不可。空なら同じオリジンの `/api/*` に接続します。 |

`PUBLIC_API_BASE` の後ろに `/api/catalog` などを付けます。値は公開HTMLの `meta[name="api-base"]` に入るため、APIキー・Bearerトークンを指定しません。ゲートウェイはサーバー側で内部APIへBearerを付け、catalog・detect・開始・読取だけを公開します。CORSには本番の `SITE_ORIGIN` を設定します。

## 公開HTML

- `/`：短い見出しとカテゴリへのリンク。
- `/category/{categoryId}/`：価格・100点スコアのラベルと比較モードへのリンク。
- `/compare/{categoryId}/{price|recommendation|specifications}/`：短い見出し・スコアラベルと関連リンク。
- `/methodology/`：既存URLを維持する短い説明。通常のナビゲーションからはリンクしません。

JavaScript無効時には見出しとリンクが読めます。アプリの起動後は `body.consumer-ready` により生成した `.public-site-nav / #public-content` を隠し、URL入力だけの画面を表示します。生の仕様値、重み一覧、長い説明を通常の画面に追加しません。実オリジンのcanonicalとパンくずを付け、架空の商品・価格・レビューは生成しません。

sitemapには公開ページだけを入れます。API・ジョブ・一時結果・クエリは含めず、一時状態と非公開ルートはnoindexにします。ジョブのアクセスキーはURLへ付けません。

## 配置

`SITE_ORIGIN` と `PUBLIC_API_BASE` を設定して、PHPを含まないフロントエンド用リリースを生成できます。

```powershell
rtk mise run xserver:static
```

出力は `dist/xserver-static/public_html/` です。この中身だけをXserverの公開ディレクトリへアップロードします。マニフェストと設置説明は公開ディレクトリの外にあります。リリース検査はソース・秘密ファイル・PHP・SQLの混入を拒否します。`.htaccess` には指定したAPIへのCSP接続許可が入ります。既存WordPressと同じ公開ディレクトリに上書きせず、専用のドメインまたはサブドメインで配置してください。

この成果物にAPIやDBは含まれません。Lambdaの本番URL・許可オリジン・プロバイダー設定とDynamoDBの3テーブルを別途用意する必要があります。`xserver:package` もPHP不要の静的成果物を `dist/xserver/public_html/` へ生成します。カテゴリ定義はDynamoDBで共有し、比較ジョブとリクエスト制限もAWS内で完結します。本番デプロイは別途必要です。

`apps/products/dist/` を公開ルートへ配置し、各ディレクトリの `index.html` を表示させます。既存の `.htaccess` を保持し、必要に応じて `DirectoryIndex index.html` とHTTPSを確認します。静的サイトにAPIの秘密情報やNodeワーカーを置きません。

バックエンドには保存許諾、TTL、公開ゲートウェイと許可オリジンを設定します。許諾未設定の永続比較は `result_storage_denied` です。URL送信、曖昧なカテゴリ選択、再読み込み、期限切れ、POST制限を実接続先で確認してから公開します。Lambdaの取消は比較ごとのアクセスキーで保護し、既存診断はサーバートークンを必要とします。

## 検査とレビュー

`rtk mise run verify` は既存検査に加え、Astroテンプレートの型検査・ESLint・整形を実行します。SolidのTS/TSXと共通ロジックの厳格なTypeScript設定は維持しています。Astroのフレームワーク型を通常のTSビルドへ混在させず、テンプレートは `astro check` が検査します。

追加したAstro/Solid統合、Astro検査・整形用依存、lockfile、ESLintの正確な役割別例外、miseの静的リリースタスクは人間のレビュー対象です。既存のguardrailケースは削除していません。
