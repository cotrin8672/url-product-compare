# Cloudflare Pages + AWS

画面をPages、API/workerとDBを既存Lambda/DynamoDBへ配置する。
Workersの新規作成画面ではなく、PagesのGit接続を選ぶ。

## 現在の公開状態（2026-10-31）

- 公開先: https://url-product-compare.pages.dev/（本番ブランチ: `main`）。
- 商品・ふるさと納税・証券の3画面のHTTP 200とAPI接続先・CSPを確認済み。
- AWSの通常設定`APPLICATION_CONFIGURATION.http.allowedOrigin`を上記Pagesオリジンへ設定し、最新のLambdaコードを反映済み。Secretには認証情報のみを保持する。
- 証券APIの3社取得・比較POST・CORSプリフライト成功、別Originの403を確認済み。ブラウザーでも3社の比較表を確認した。
- 証券の条件データは確認期限を過ぎており、画面上のポイント試算は更新待ち。API疎通成功と試算可能な状態は区別する。
- AWS側の楽天市場・楽天ふるさと納税は設定済み。カタログAPIは200だが、楽天の商品検索は許可サイト未登録（`HTTP_REFERRER_NOT_ALLOWED`）で拒否されている。さとふるなど残りの取得元は未設定。
- Jevの実API評価とアクセストレードWSIDの認証を確認済み。WSID認証は証券案件の商品フィード取得を意味しない。
- `SITE_ORIGIN`を未設定でビルドした初期公開のため、検索エンジン向けにはnoindex。

## Pagesの設定

| 設定              | 値                                                                          |
| ----------------- | --------------------------------------------------------------------------- |
| リポジトリルート  | `/`（apps/webに変更しない）                                                 |
| ビルドコマンド    | `pnpm run build:pages`                                                      |
| 出力先            | `apps/web/dist`                                                             |
| `NODE_VERSION`    | `24.22.1`                                                                   |
| `PNPM_VERSION`    | `10.34.5`                                                                   |
| `PUBLIC_API_BASE` | `https://bjbiijxxbjkhgk6w3xr2mrneky0xftnb.lambda-url.ap-northeast-1.on.aws` |
| `SITE_ORIGIN`     | 公開先の正確なHTTPSオリジン。未確定の初期確認では空にする（noindex）        |

AWSのURLは2026-10-29に専用プロファイルのCloudFormation出力から確認した。
フロントエンドの環境変数にはASPトークン、AWS認証、API_ACCESS_TOKENなどを入れない。
Pagesの`CF_PAGES=1`では、pnpm自身の実行パスを使うため、mise/rtkのインストールは不要。
ローカルでは引き続き `rtk proxy mise exec -- pnpm run build:pages` を使う。
`PUBLIC_API_BASE` と、確定済みなら `SITE_ORIGIN` をコマンド実行環境に指定する。

## 生成と検証

- ビルド時に既存ページ・API接続先・canonical・sitemap・静的アセットを検証する。
- Pages用の`_headers`を生成し、CSPの通信先を指定したAPIオリジンに限定する。
- `404.html`を生成し、存在しないURLをトップページへフォールバックさせない。
- 公開ディレクトリにソース、秘密情報用ファイル、PHP、Node依存などが含まれないことを検証する。
- HTML/JSは生成するが、実際の商品API・AI APIを呼んだり、AWSを更新したりはしない。

## 公開前に行うこと

Pagesのプロジェクトと公開URLが決まったら、AWSの通常設定`APPLICATION_CONFIGURATION`にある`http.allowedOrigin`を同じオリジンに設定し、
既存のLambda更新手順で反映する。CloudFormationの設定Secretを更新するだけでは、Lambda環境変数には反映されない。
本番のサブドメインを追加する場合は、そのURLでPagesを再ビルドし、AWS側も合わせて更新する。
PreviewのURLは本番Originに自動的に許可されないため、本番と同じAPIへの接続成功を期待しない。

Pagesのアップロード成功と、AWSの商品取得・AI比較の稼働確認は別々に確認する。
既存のAWSは一部providerを無効にした状態で配置されており、公開URLを設定しただけでは有効化されない。

仕様: [ビルド](https://developers.cloudflare.com/pages/configuration/build-configuration/)、
[_headers](https://developers.cloudflare.com/pages/configuration/headers/)、
[404](https://developers.cloudflare.com/pages/configuration/serving-pages/)。
