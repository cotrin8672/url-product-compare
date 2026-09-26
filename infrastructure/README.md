# AWSへの公開

構成: Amplify Hosting（Solidの静的ファイル）→ 同一オリジンの `/api/*` プロキシ → HTTP API → Node.js 24 Lambda → Aurora PostgreSQL Data API。

アプリはデモのままです。楽天・Jevへの本番リクエストは送信しません。DBには実行日時・成功/失敗・demoという区分だけを保存し、入力URL、商品、価格、AI評価は保存しません。商品データの保存は許諾と期限の確認を実装してから追加します。

## ローカルで検証・ビルド

```powershell
rtk mise run verify
rtk proxy pwsh -NoProfile -File tooling/package-aws.ps1
rtk mise exec -- node tooling/check-aws.mjs
```

Lambda用にアプリと承認済みSDKを `apps/api/dist/lambda` に配置します。画面のアップロード用ZIPは `apps/api/dist/web.zip` です。どちらもGit対象外です。

## 1. 先に公開URLを作る

新しいAWSアカウント、東京リージョンで Amplify → 新しいアプリ → Gitプロバイダーなしでデプロイを選びます。アプリ名は `url-product-compare`、ブランチ名は `main` とし、`apps/api/dist/web.zip` をアップロードします。

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

このデモは匿名で呼び出せます。実商品/有料AIを接続する前に利用者認証・利用者別上限を追加します。今回のスロットリングだけでは不正利用を防げません。

## レビュー対象・未確認事項

- 承認済みSDKとlockfile、AWS SDKを当該adapterだけに許可したESLint設定、transportテストの限定依存、ローカル起動のscript変更、Knipへの実行入口の明示はレビュー対象です。検査は無効化していません。
- ローカル検証とパッケージ作成は行いますが、実AWSアカウントへの作成・Data API接続・Amplifyのプロキシはデプロイ後に確認する必要があります。
- GitHub連携による自動デプロイはまだ設定しません。最初の公開URLは上記の手動アップロードで確定できます。

公式資料: [Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)、[Aurora自動停止](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)、[CloudFormation package](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/package.html)、[Amplifyプロキシ](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html)。
