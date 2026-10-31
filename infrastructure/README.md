# Firebaseへの移行・公開手順

この文書は旧Firebase構成の互換検証用です。今後の移行先であるXserver＋Lambdaの手順は [こちら](lambda/README.md) を参照してください。既存リソースの停止・削除はローカルの実装やビルドでは行いません。

画面をFirebase Hosting、APIをCloud Functions第2世代、操作記録をCloud Firestoreへ置き換えました。リージョンは東京 `asia-northeast1`。開発時はmiseのNode.js 24、FunctionsはFirebaseが対応するNode.js 22を使います。

Hostingの `/api` と `/api/**` は `api` 関数へ転送し、それ以外はSolid.jsの画面へ転送します。画面は商品URLだけで比較でき、ブラウザー用トークン・Firebase SDK・APIキー・Firebase Authenticationの設定は不要です。`createPublicConsumerApi` がカタログGET、判定POST、比較作成POST、ジョブGETだけにサーバー内のBearer認証を渡します。旧診断・同期比較・取消の経路は従来のBearer認証を維持します。

ブラウザーのOriginは設定済みの `http.allowedOrigin` または楽天設定の `allowedOrigin` と一致する必要があります。設定がない場合はFunctionsのリクエストから得た同一オリジンに限定します。Originのない直接リクエストも接続元の制限を受けます。高コストのPOSTはネイティブソケットの接続元アドレスにつき毎分6回、アドレス管理は最大1024件です。この上限はインスタンス内のメモリで管理し、複数インスタンスを横断する利用者別上限ではありません。任意の転送先パスや転送ヘッダーのアドレスを信用しません。

Firestoreの `investigation_runs` に保存するのは、従来のデモ商品確認POSTの `mode`・`status`・サーバー時刻 `createdAt`・30日後の削除対象時刻 `expiresAt` だけです。この操作記録には実商品・URL・利用条件・候補・キーを保存しません。GET・health・充電器比較は記録しません。保存失敗は503を返します。ブラウザーからのFirestoreアクセスはルールで全面拒否し、サーバーはAdmin SDKと実行サービスアカウントのIAMで接続します。

メイン比較は `POST /api/comparisons` でジョブを受け付け、`comparison_jobs` を作成します。HTTP処理は202を返し、`comparisonJobWorker` のFirestore作成トリガーが比較を実行します。トリガーには再試行を設定し、実行が中断したジョブは45秒のリース失効後に引き継げます。HTTPとワーカーの提供元登録は `bootstrap.ts` の `createConfiguredConsumerService` を共用しています。ローカルでは同じ状態遷移を使うメモリストアを利用します。

楽天の取得情報・比較結果は取得時点から15分の有効時間で扱います。独自の利用停止日・保存許諾日の入力は不要です。現在のLambda構成では、認証情報と通常設定を分離します。[Lambdaの設定手順](lambda/README.md)を参照してください。

ジョブは入力URL・条件・操作のダイジェスト・状態を保存し、アクセス鍵はダイジェストだけを保存します。クライアントは操作ごとのランダムな `idempotencyKey` と `x-comparison-key` を最初のPOSTから送ります。同じキー・入力・アクセス鍵による再送は同一ジョブを返し、異なる入力は409、異なるアクセス鍵は403です。公開GETもこのアクセス鍵が必要です。旧取消APIはBearer認証とこの鍵を要求します。ブラウザーには結果本文を永続保存せず、セッション内にジョブID・鍵・期限・revisionを保持します。

メタデータ期限は最大60分、結果は最大15分かつ全商品の表示期限・保存許諾期限の最も早い時刻までです。期限はAPIが検証し、期限切れ結果を返しません。失敗・取消時に結果は残しません。`comparison_jobs.cleanupAt` はFirestoreの日時型で、成功時には結果の期限、その他はメタデータ期限を設定します。このフィールドのネイティブTTLと全フィールドのインデックス除外をデプロイしてください。TTLの物理削除は即時ではないため、許諾上の削除要件がTTLの削除猶予を認めない場合、この永続保存を有効にしないでください。

## Firestoreのアクセスと費用

2026-10-02に費用を優先してFirestoreを採用しました。SQL Connect・Cloud SQLインスタンスの作成は不要です。現在の各リクエストのDB操作は以下のとおりです。

| 経路                               | 読み取り | 書き込み |
| ---------------------------------- | -------: | -------: |
| デモ商品の確認POST（成功・失敗）   |        0 |        1 |
| デモ確認GET・health・充電器比較    |        0 |        0 |
| 実商品取得・候補検索・公式商品比較 |        0 |        0 |
| 入力不正・認証失敗・未対応ルート   |        0 |        0 |

操作記録はSDKのランダムIDで直接追加します。存在確認、全件走査、件数集計、リアルタイム購読、商品ごとのDB再取得はありません。単一の集計文書の毎回更新や、削除用の定期スキャンも追加しません。

`firestore.indexes.json` で、検索しない操作記録の全フィールドを単一フィールドインデックスの対象外にしています。TTL用の `expiresAt` もインデックスなしです。インデックスを外す効果は保存容量と書き込み時の負荷の削減であり、1回の文書書き込みの課金数は変わりません。このコレクションを条件検索・時刻順で表示する管理画面を追加する際は、実際のクエリに必要なインデックスだけを定義します。

TTLは30日後に削除対象とし、通常は期限後24時間以内に削除されます。即時削除の保証ではありません。`expiresAt` のない既存記録には適用されません。TTL削除は無料枠の対象外ですが、東京では100万件で約21円です。一般公開の個人結果にこの30日間を流用せず、保存許可・表示期限を別途検証してください。

東京のStandard editionは1日5万読み取り・2万書き込み、保存1GiBが無料枠です。超過100万件の読み取りは約60円、書き込みは約182円、追加保存1GiBは月約18円です（2026-10-02確認、1ドル158円、税別概算）。デモ確認が毎日2万回以内かつ保存1GiB以内なら通常の読み書き・保存は無料枠に収まり、TTL削除分は別です。Functions、Hosting、Secret Manager、ビルド成果物、AI APIは別料金です。

将来、履歴や保存結果を追加するときも、APIのアクセス目的ごとに読み取り数を決めます。

- 結果表示は認証済み利用者の結果IDによる直接取得を基本にし、保存許可がある表示項目をまとめます。提供元の停止・失効の確認は省かず、その追加読み取りも計上します。
- 一覧は利用者などの等値条件、必要な並び順、最大50件の `limit`、`startAfter` のカーソルで取得します。全件取得後の絞り込みや `offset` は使いません。
- 候補最大5件と入力商品を表示するためだけに、各商品・価格・根拠を別クエリで繰り返し取得する設計を避けます。取得をまとめても文書数ぶん課金される点は変わりません。
- 複数の範囲条件によるインデックス読み取りはQuery Explainで確認します。件数集計を毎回行わず、購読やポーリングは対象ジョブだけに限定し、完了時に停止します。
- 結果の有効期限は取得時にも検証し、TTLの物理削除を待って表示を止める設計にはしません。

上の操作回数は従来の診断ルートについてです。ジョブ作成・進捗・取消・完了は対象文書のトランザクション読み書き、ポーリングは対象ジョブの読み取りを行います。操作キーのダイジェストを文書IDに使い、コレクション検索や全件走査を行いません。パッケージ検査は従来ルートのDB操作数を維持し、追加の統合検査でジョブの受付・取得・取消・TTL・保存拒否を確認します。

根拠：[Firestore料金](https://cloud.google.com/firestore/pricing)、[クエリの課金](https://firebase.google.com/docs/firestore/pricing)、[インデックスとクエリの推奨事項](https://firebase.google.com/docs/firestore/best-practices)、[TTL](https://firebase.google.com/docs/firestore/ttl)。

## 1. Firebaseプロジェクトを作る

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成し、プロジェクトIDを控えます。以降の `YOUR_PROJECT_ID` をこのIDに置き換えてください。
2. Cloud Functionsのデプロイには **Blazeプラン** が必要です。請求先を紐づけ、Google Cloud Billingで予算通知を設定します。
3. Firestore Databaseを作成します。**Standard edition・Native mode・データベースID `(default)`・東京 `asia-northeast1`・本番モード** を選びます。手動のコレクション作成は不要です。
4. Hostingを有効にします。`firebase init` は実行しないでください。構成は用意済みです。

Functionsは最小0・最大2インスタンス、各10同時実行、256MiB、60秒です。インスタンス上限・POST制限・予算通知は支出の絶対上限ではありません。Bearerトークンはサーバーだけに置き、公開比較の入口で使用します。新しい認証基盤や共有された利用者別上限は追加しません。

## 2. ローカルを準備する

プロジェクトルートで実行します。Firebase CLIは開発依存に固定済みです。

```powershell
rtk mise trust
rtk mise install
rtk mise run install
rtk mise exec -- pnpm exec firebase login
rtk mise run verify
rtk mise run firebase:package
```

`firebase:package` は画面とAPIをビルドし、lockfileから本番SDKを `apps/api/dist/firebase` にまとめます。生成先は毎回作り直します。ESM読み込み、HTTP・認証・入力検証・Firestore配線・保存エラーも外部呼び出しなしで検査します。秘密情報はコピーしません。

## 3. サーバー設定をSecret Managerへ登録する

楽天のApplication URL・Allowed websitesに、新しいHostingのURL・ホスト（`https://YOUR_PROJECT_ID.web.app` / `YOUR_PROJECT_ID.web.app`）を登録してください。独自ドメインの場合はそのオリジンを登録し、下記の `allowedOrigin` に同じ値を設定します。

[api-configuration.example.json](api-configuration.example.json) をコピーして `infrastructure/api-configuration.json` を作り、値を編集します。このファイルはGit対象外です。

```powershell
rtk proxy pwsh -NoProfile -Command 'Copy-Item -LiteralPath infrastructure/api-configuration.example.json -Destination infrastructure/api-configuration.json'
```

- `rakuten` の6項目はすべて必須です。既存の楽天アプリID・アクセスキー・Affiliate IDを使えます。
- `accessToken` はサーバー内だけで使うランダムなbase64url形式の32〜256文字です。ブラウザーや公開HTMLには渡しません。作る場合は `rtk mise exec -- node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` を手元で実行し、出力を設定します。提供元から独立したHTTP設定が必要な場合は、任意の `http` に `{"accessToken":"YOUR_SERVER_TOKEN","allowedOrigin":"https://YOUR_SITE_HOST"}` を指定します。
- OpenAIを使う場合は `openai` にキー・モデルを設定します。使わない場合は **`"openai": null`** にしてください。
- メインの6カテゴリ比較はOpenAIを使いません。Jevの任意の抽出補助を使う場合だけ `jev` に `{"apiKey":"YOUR_JEV_API_KEY","model":"jev-1.13.0"}` を設定します。`jev` は省略または `null` でも比較できます。
- 架空デモだけを先に公開する場合は、ファイル全体を **`{"rakuten":null,"openai":null}`** にします。設定の省略や不完全な設定ではエラーを返し、デモは明示的なnull設定に限ります。

登録します。キーをコマンド引数やチャットへ貼る必要はありません。

```powershell
rtk mise exec -- pnpm exec firebase functions:secrets:set API_CONFIGURATION --data-file infrastructure/api-configuration.json --project YOUR_PROJECT_ID
```

更新後も同じ登録コマンドを実行し、関数を再デプロイします。既存のルート `.env` はローカル用のままで、クラウドへ自動送信されません。サービスアカウント鍵のダウンロードは不要です。

## 4. デプロイする

```powershell
rtk mise exec -- pnpm exec firebase deploy --project YOUR_PROJECT_ID --only "functions,hosting,firestore"
```

CLIから必要なGoogle Cloud APIの有効化・Secret Managerアクセス権・公開HTTP関数の設定を求められたら内容を確認して進めます。`firestore` の指定でルール・インデックス除外・TTLをまとめて反映します。既存プロジェクトの場合、この操作は既定HostingサイトとFirestore設定を更新するため、専用プロジェクトを推奨します。既存の別用途のインデックス削除を求められた場合は削除を承認せず、その定義を先に設定ファイルへ取り込んでください。

デプロイ前フックでもverifyとパッケージ作成を実行します。`pinTag` でHostingと関数の版を揃えます。初回のArtifact Registry保存期間の質問では、不要な古いビルドを短期間で削除する設定を選べます。

## 5. 公開後に確認する

1. `https://YOUR_PROJECT_ID.web.app/api/health` を開き、200と `mode: "live"` を確認します。架空デモ設定なら `mode: "demo"`。OpenAI設定済みなら `mainAiConfigured: true` です。healthだけではDB書き込みは確認できません。
2. Hostingの画面を開き、楽天の商品URLを入力して比較します。ブラウザーへの認証設定は不要です。カテゴリが曖昧な場合だけ選択します。
3. メインAPIは非同期 `POST /api/comparisons` です。保存許諾が設定されていない永続APIは受付を拒否します。OpenAI未設定でも使え、Jevは設定した場合に本文の曖昧な容量の割り当てだけ最大1回使います。Jev未設定や抽出失敗でも、確認できた仕様を表示します。旧充電器の診断用 `POST /api/candidates` は設定により有料APIを使う場合があります。従来のモニター診断は `/compare/monitor/` に保持します。
4. デモ設定では、デモ商品の確認POST後にFirestore Consoleの `investigation_runs` を確認します。`expiresAt` が日時型で約30日後になっていること、Google Cloud ConsoleのFirestore「Time-to-live」で `investigation_runs.expiresAt` が有効になっていることを確認します。TTL有効化には10分以上かかる場合があります。実商品モードの操作は保存しません。
5. 503 `storage_unavailable` が出たら、既定DBの存在と、関数の実行サービスアカウントにFirestore書き込み権限（例：Cloud Datastore User）があることを確認します。ルールの公開許可ではAdmin SDKのIAM問題は解決しません。

Firebaseへの公開・実キーの疎通・請求・IAMはこの手順で確認してください。

## 6. AWSから切り替える

新URLで確認が完了してから、必要に応じて独自ドメインをHostingへ追加し、DNSを切り替えます。楽天の登録オリジンとSecretの `allowedOrigin` も揃えて再デプロイします。

Amplify・Lambda・API Gateway・Aurora・Secrets Manager等のAWSリソースは、コード変更では停止・削除しません。利用箇所とバックアップを確認した後、不要なリソースをAWS側で停止・削除してください。既存Auroraには実行成否しか保存していないため、アプリ稼働に必要なデータ移行はありません。過去の操作記録が必要なら削除前にエクスポートしてください。

通常のローカルAPI・Vite起動はREADMEの手順を継続できます。Firestoreを含むエミュレーター検証をする場合は、パッケージ作成後の `apps/api/dist/firebase/.secret.local` に `API_CONFIGURATION={"rakuten":null,"openai":null}` を記載し、Firestoreエミュレーターが要求するJavaを用意してから実行します。パッケージを作り直すと `.secret.local` も消えます。

```powershell
rtk mise exec -- pnpm exec firebase emulators:start --project demo-url-product-compare --only "hosting,functions,firestore"
```

公式資料：[Hosting＋Functions](https://firebase.google.com/docs/hosting/functions)、[Functionsのランタイム](https://firebase.google.com/docs/functions/manage-functions)、[JSON Secret](https://firebase.google.com/docs/functions/config-env#structured_json_secrets)、[Admin SDK](https://firebase.google.com/docs/admin/setup)、[Node.js buildpacksとpnpm](https://docs.cloud.google.com/docs/buildpacks/nodejs)。
