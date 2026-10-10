# Xserver 向け静的フロントエンド

`tooling/build-site.mjs` は公開カタログの短いHTMLとViteアセットを `apps/web/dist/` に生成します。Xserverには静的フロントを配置し、公開ゲートウェイ・内部API・ワーカーは別のバックエンドで運用します。この作業ではデプロイを行っていません。

## 生成と接続先

本番環境変数を設定し、ルートから実行します。

```powershell
rtk mise exec -- node tooling/build-site.mjs
```

生成器は既存のbackendコンパイルとWebビルドを実行し、コンパイル済み `publicConsumerCatalog()` だけを読みます。カテゴリや評価軸の代替表はありません。固有タイトル・見出し・スコアラベル・canonical・公開ルート・sitemapを検証します。

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

`apps/web/dist/` を公開ルートへ配置し、各ディレクトリの `index.html` を表示させます。既存の `.htaccess` を保持し、必要に応じて `DirectoryIndex index.html` とHTTPSを確認します。静的サイトにAPIの秘密情報やNodeワーカーを置きません。

バックエンドには保存許諾、TTL、公開ゲートウェイと許可オリジンを設定します。許諾未設定の永続比較は `result_storage_denied` です。URL送信、曖昧なカテゴリ選択、再読み込み、期限切れ、POST制限を実接続先で確認してから公開します。保護された取消と既存診断は公開ゲートウェイに接続しません。
