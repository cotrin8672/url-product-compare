# Render Freeへの公開

画面とAPIを1つのFree Web Serviceで動かします。比較ジョブは既存のメモリストアを使い、Firestore・Redis・永続ディスクは作りません。15分アクセスがないと休止し、復帰には約1分かかります。休止・再起動・再デプロイではジョブと結果が消えるため、再比較してください。

## サービス設定

`render.yaml` に再現用の設定があります。Renderで対象ブランチを選び、以下の設定を使います。

| 設定              | 値                                                  |
| ----------------- | --------------------------------------------------- |
| Runtime           | Node                                                |
| Plan              | Free                                                |
| Region            | Singapore                                           |
| Root directory    | リポジトリルート（空欄）                            |
| Build command     | `bash infrastructure/render-build.sh`               |
| Start command     | `node apps/api/dist/firebase/apps/api/src/local.js` |
| Health check path | `/api/health`                                       |
| `NODE_VERSION`    | `24.21.0`                                           |

ビルドはmiseで固定されたNode.js/pnpmを使い、既存の本番パッケージ生成を流用します。生成先に`firebase`という名前が残っていますが、起動するのはDBを使わないNodeサーバーです。公開HTMLはRenderのURLから生成し、APIも同じオリジンに接続します。

## サーバーの環境変数

以下をRenderのEnvironmentに設定します。値をGit・公開HTML・チャットに貼り付けないでください。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `RAKUTEN_AFFILIATE_ID`
- `API_ACCESS_TOKEN`（ランダムなbase64url形式、32〜256文字）

`RAKUTEN_ALLOWED_ORIGIN`と`API_ALLOWED_ORIGIN`は省略すると`RENDER_EXTERNAL_URL`を使います。独自ドメインへ変更するときは両方にそのHTTPSオリジンを設定します。

楽天アプリのApplication URLには`https://url-product-compare.onrender.com`のようなHTTPS URLを、Allowed websitesには`url-product-compare.onrender.com`のようなスキームなしのホスト名を登録します。Allowed websitesに`https://`を含めると入力エラーになり保存できません。独自ドメインへ変更するときも、それぞれの形式で登録してください。

独自の利用停止期限・保存許諾期限の入力は不要です。取得情報と比較結果の有効時間はアプリ側で管理します。

## 公開前の確認

```powershell
rtk mise run verify
rtk mise run firebase:package
rtk mise exec -- node --env-file=.env apps/api/dist/firebase/apps/api/src/local.js
```

公開後はトップページ・生成したカテゴリページ・`/api/health`・URL入力からの比較を確認します。キーなしの旧診断APIは認証エラー、`.env`やソースファイルは404になることも確認します。

接続元の制限はソケットのアドレスごとに毎分6回です。Renderのプロキシを通すと複数の利用者が同じ枠を共有する場合があります。利用者が増えて制限が支障になる場合に、Renderの転送ヘッダーの信頼条件を確認して対応してください。

参考：[Render Freeの制限](https://render.com/docs/free)、[Web Services](https://render.com/docs/web-services)、[環境変数](https://render.com/docs/environment-variables)。
