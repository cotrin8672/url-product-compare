# AWSへの公開

構成: Amplify Hosting（Solidの静的ファイル）→ 同一オリジンの `/api/*` プロキシ → HTTP API → Node.js 24 Lambda → Aurora PostgreSQL Data API。

設定なしではデモです。楽天のサーバー設定をすべて追加した場合だけ実商品APIを呼びます。Jevへの本番リクエストは送信しません。DBにはデモの実行日時・成功/失敗・demoという区分だけを保存し、入力URL、商品、価格、AI評価は保存しません。実商品取得はDBに保存しません。

## ローカルで検証・ビルド

```powershell
rtk mise run verify
rtk proxy pwsh -NoProfile -File tooling/package-aws.ps1
rtk mise exec -- node tooling/check-aws.mjs
```

Lambda用にアプリと承認済みSDKを `apps/api/dist/lambda` に配置します。画面のアップロード用ZIPは `apps/api/dist/web.zip` です。どちらもGit対象外です。

ローカルでAurora接続も確認する場合は、依存を含むパッケージを作成した後、`rtk mise exec -- node --env-file=.env apps/api/dist/lambda/apps/api/src/local.js` で起動します。デモと楽天の商品取得だけなら通常のローカル起動で確認できます。

## 1. 先に公開URLを作る

公開済みURL: `https://main.d3f6j2d66bsp2x.amplifyapp.com/`。AmplifyはGitHubの `main` と接続し、モノレポのアプリルートを `apps/web` に設定しています。ビルドはリポジトリルートで `mise.toml` のNode/pnpmを使用し、`apps/web/dist` を公開します。コンソールのYMLに設定したビルド設定を維持してください。

初回は画面だけが公開され、商品検索APIは未接続です。表示されたHTTPS URLを楽天の Application URL、ホスト名を Allowed websites に使用します。実際のURLはAmplifyが発行するため、事前に推測して入力しません。

## 2. APIとDBを作る

`infrastructure/aws.json` がリソース定義です。まだAWSに作成していません。実行には作成先のメンバーアカウント用AWS CLIプロファイル、非公開のS3アーティファクトバケットが必要です。先に `sts get-caller-identity` で作成先アカウントを確認します。

```powershell
rtk proxy aws sts get-caller-identity --profile compare
rtk proxy aws rds describe-orderable-db-instance-options --profile compare --region ap-northeast-1 --engine aurora-postgresql --db-instance-class db.serverless --query "OrderableDBInstanceOptions[].EngineVersion" --output text
```

表示されたバージョンから、Data APIと0 ACU自動停止に対応する現行16系（16.3以降）などを選びます。テンプレートには未確認のバージョンを初期値として固定していません。

```powershell
rtk proxy aws cloudformation package --profile compare --region ap-northeast-1 --template-file infrastructure/aws.json --s3-bucket YOUR_PRIVATE_ARTIFACT_BUCKET --output-template-file apps/api/dist/packaged.json --use-json
rtk proxy aws cloudformation validate-template --profile compare --region ap-northeast-1 --template-body file://apps/api/dist/packaged.json
rtk proxy aws cloudformation deploy --profile compare --region ap-northeast-1 --template-file apps/api/dist/packaged.json --stack-name url-product-compare --capabilities CAPABILITY_IAM --parameter-overrides EngineVersion=YOUR_VERIFIED_VERSION --no-execute-changeset
```

作成された変更セットをCloudFormation画面で確認して実行します。既存アカウントでの新規無料クレジットは見込みません。DB停止中もストレージ、Secrets Managerなどの料金は残ります。DBは0〜1 ACU、無通信5分で自動停止、APIは毎秒1リクエスト・バースト2、Lambda同時実行2、ログ保持7日です。これらは支出の絶対上限ではありません。DB削除時のスナップショットにも保存料金が発生します。

DBは新しいVPCの非公開サブネット2つに配置します。NAT Gateway、公開IPv4、RDS Proxy、追加の読み取りインスタンスは作りません。LambdaはVPC外からData APIを呼ぶため、外部商品APIへのアクセスにNATは不要です。

## 3. DBを初期化する

CloudFormationの出力から `ClusterArn`、`MasterSecretArn`、`AppSecretArn` を控えます。ARNは識別子です。秘密鍵やパスワードをチャットに貼り付ける必要はありません。

```powershell
rtk proxy pwsh -NoProfile -File tooling/initialize-aws-db.ps1 -Profile compare -ClusterArn CLUSTER_ARN -MasterSecretArn MASTER_SECRET_ARN -AppSecretArn APP_SECRET_ARN
```

初期化は管理者資格情報を使ってテーブルと `compare_app` ユーザーを作ります。実行用Lambdaは管理者シークレットへアクセスできず、アプリユーザーもテーブルへのメタデータINSERTだけ許可されます。初期化失敗時は中断し、再実行できます。パスワードを含む一時ファイルはGit対象外のdist内に作り、終了時に削除します。この処理を実行する端末は信頼できる端末に限定してください。

## 4. 画面からAPIへ接続する

Amplify → リダイレクトと書き換えで、下記の200書き換えを最初に追加します。`API_ORIGIN` はCloudFormationの `ApiOrigin` 出力に置き換えます。

```json
[{ "source": "/api/<*>", "target": "API_ORIGIN/api/<*>", "status": "200" }]
```

API応答には `Cache-Control: no-store` を設定します。`/api/health` はDBを起動せずに200を返します。画面のデモ商品を検索し、DBの `investigation_runs` に記録されたことを管理者で確認します。保存障害時は503を返し、保存できたようには扱いません。

デモは匿名で呼び出せます。実商品モードは動作確認用BearerトークンとPOSTを要求し、GETでは外部APIを呼びません。これは少人数の検証用で、一般公開・有料AI接続には利用者認証・利用者別上限が必要です。

## 5. 楽天の実商品取得を有効にする

先にローカルの `.env` で [READMEの実商品接続手順](../README.md#楽天の実商品を確認する) を確認します。登録済みアプリの Application URL は公開済みURL、Allowed websites は `main.d3f6j2d66bsp2x.amplifyapp.com` です。

Lambdaの「設定 → 環境変数」に `.env.example` の6項目（`RAKUTEN_AFFILIATE_ID` を含む）を設定します。キーとトークンをAmplifyのフロント環境変数やGitに設定しません。すべて設定した場合だけ `/api/health` のmodeが `live` になります。画面の「接続設定」には楽天のキーではなく `API_ACCESS_TOKEN` を入力します。API・DB未デプロイの段階ではフロントだけから楽天へアクセスできません。

Lambdaのコード更新やCloudFormationによる再デプロイでは手動設定した環境変数が維持されるかを確認してください。テンプレート内のデフォルト環境変数はDB設定だけです。実商品設定の一部だけが残ると起動を停止します。

## レビュー対象・未確認事項

- 承認済みSDKとlockfile、AWS SDKを当該adapterだけに許可したESLint設定、transportテストの限定依存、ローカル起動のscript変更、Knipへの実行入口の明示はレビュー対象です。検査は無効化していません。
- ローカル検証とパッケージ作成は行いますが、実AWSアカウントへの作成・Data API接続・Amplifyのプロキシはデプロイ後に確認する必要があります。
- フロントはGitHub連携で公開済みです。今回のバックエンドの変更はLambdaのパッケージ作成・デプロイが別途必要です。

公式資料: [Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)、[Aurora自動停止](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)、[CloudFormation package](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/package.html)、[Amplifyプロキシ](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html)。
