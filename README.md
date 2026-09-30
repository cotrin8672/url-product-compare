# url-product-compare

商品URLから比較候補を探し、AIで条件に合う商品を比較するサービス。

現在はURL検査・製品同定・価格比較条件・成果リンクの検証境界と、Jevを使う候補評価ロジック、Solid.jsの動作確認UIとAPIを実装しています。楽天の実商品取得と、OpenAIが要望から検索条件を作って実商品の候補を取得する接続があります。他店との同一製品比較、候補の製品・仕様の確認、実データに基づくJev評価は未実装です。

## 商品同定ロジック

`packages/backend/src/comparison/investigate.ts` の `investigateProduct(input, providers, clock)` が入口です。登録済みの `ProductDataProvider` からURLを解決し、取得許諾・掲載ID・出典・時刻・製品の一致を検証します。楽天のURL規則は `providers/rakuten` にあり、別媒体はProvider登録で追加できます。

`Result` は処理失敗、`Option` は欠損を表します。掲載ID・製品IDは提供元ごとに区別し、スキーマ検証済みの `Product` と同定根拠付きの `IdentifiedProduct` は別型です。バリエーションの未確認と確認済みの非該当も区別します。価格は通貨・税・送料・在庫・数量・配送条件・取得時刻・期限が揃う場合だけ総額比較できます。取得・表示・保存・AI送信・成果リンクの許諾は独立しています。

`AffiliateProvider` は商品データProviderとは独立して注入します。比較候補の成果リンクには製品・掲載・バリエーション・期限・遷移先の照合とProviderによる遷移先検証が必要です。利用できない候補を通常購入リンクで埋めません。この比較候補用Adapterは未接続です。現在の楽天実商品モードでは、入力URLと一致した掲載について楽天APIが返した成果リンクを表示します。これは製品・SKUを同定済みの比較候補ではありません。`httpsUrl` 型はURL構文の検証のみで、外部URLを安全に取得できる保証ではありません。

候補評価は、確認済みの必須条件をコードで判定した後、各候補へ同じ複数のScore質問をJevに送り、固定した重みで集計します。出典やAI送信権限が欠ける候補、低信頼の回答、Jev障害では順位を作りません。僅差は同順位です。内部指数は校正前なので公開用の適合度％ではありません。価格の安い順は別途、確認済み総額をコードで並べる必要があります。

最初のCLIは架空の商品だけを扱うローカルデモで、外部API・アフィリエイト・Jevには接続しません。2番目は同じく架空の商品を実際のJev APIで評価する接続確認です。`TYPESAFE_API_KEY` が必要で、結果は公開用評価ではありません。

```sh
rtk mise exec -- pnpm --filter @app/worker demo --demo
rtk mise exec -- pnpm --filter @app/worker exec tsc --noEmit false
rtk mise exec -- node --env-file=.env apps/worker/dist/apps/worker/src/index.js --jev-demo
rtk mise run verify
```

`verify` は機能テストも実行します。Solid.js画面にはSolid.js・Vite・ViteのSolidプラグインを追加しました。新しいworkspaceの設定とverifyへのテスト追加はレビュー対象です。

## セットアップ

AWSの公開構成・パッケージ作成・DB初期化は [infrastructure/README.md](infrastructure/README.md) にまとめています。設定なしではデモです。Auroraにはデモ操作の成否だけを保存し、実商品データや入力URLは保存しません。実商品取得は保存しません。

```sh
mise trust
mise install
mise run install
mise run verify
```

## ブラウザーでの動作確認

別々のターミナルでAPIとSolid.js画面を起動し、`http://127.0.0.1:5173/` を開きます。

```sh
rtk mise exec -- pnpm --filter @app/api dev
rtk mise exec -- pnpm --filter @app/web dev --host 127.0.0.1
```

「架空データのURLを入力」で `https://item.rakuten.co.jp/demo-shop/demo-product/` を入れると、デモモードで商品同定まで確認できます。画面に架空の価格比較結果は出しません。

### 楽天の実商品を確認する

`.env.example` を参考に、Git対象外の `.env` に楽天のアプリID・アクセスキー・Affiliate ID・登録済みオリジン、取得/表示/成果リンクの利用を再確認する期限（UTCの `2026-10-07T14:59:59.000Z` のような形式）、ランダムな動作確認用トークン（base64url、32文字以上）の6項目を設定します。`RAKUTEN_DATA_AUTHORIZED_UNTIL` はアプリ内部の停止期限で、楽天が発行する値ではありません。実際の利用条件を満たす範囲で設定します。保存・AI送信は許可しません。設定が一部だけの場合は起動を停止します。

```dotenv
RAKUTEN_AFFILIATE_ID=楽天で取得したAffiliateID
```

Affiliate IDは通常、8桁の16進数をドットで4組つないだ形式です。収益化を前提とした実商品モードでは必須にしています。楽天の商品検索API自体では省略できますが、省略すると成果リンクは返りません。

APIを次のコマンドで起動します。画面の起動方法は上記と同じです。

```powershell
rtk mise exec -- pnpm --filter @app/api exec tsc --noEmit false
rtk mise exec -- node --env-file=.env apps/api/dist/apps/api/src/local.js
```

画面の「接続設定」に動作確認用トークンを入れ、楽天の商品URLを入力して「調べる」を押します。トークンは画面のメモリーだけに保持し、保存しません。楽天のアクセスキーはサーバーだけに置きます。許諾が期限切れなら外部APIを呼ばずに停止します。

URLの末尾をAPIの `itemCode` として送信しません。ショップ内をURL末尾または補助の商品名で検索し、結果の掲載先が入力の正規URLに完全一致した掲載だけを返します。Affiliate IDを渡すと `itemUrl` も成果リンクになるため、そのPC遷移先を検証して掲載先を取り出します。見つからない場合は「接続設定」に商品名を入力します。検索は1ページ30件に限定しているため、候補が多い場合は商品名を絞ります。商品名の一致だけで同一製品と判断しません。

実商品モードでは、楽天が返した実 `itemCode`、店名、SKUの掲載価格幅、税込/税別、送料込み/別、購入可否と「楽天で見る（広告）」を表示します。成果リンクは独自に組み立てずAPIの `affiliateUrl` を使用し、HTTPS・楽天の追跡ホスト・設定したAffiliate ID・掲載先の一致を検証します。モバイル遷移先がある場合はPCと同じ商品URLに限定し、旧式のモバイルURLや検証できない応答ではリンクを出さずエラーにします。サーバーから成果リンクをクリックして検証することはありません。

メーカー・型番・JAN・選択SKU・配送先別送料は確認できないので、製品IDと同定方法は `null`、総額は未確認です。表示は取得から15分または設定期限までに限り、期限後は再取得を案内します。DBへの保存・AI送信は行いません。実際の成果計測は楽天側で行われ、実IDでの疎通・成果反映は別途確認が必要です。

実APIモードはPOSTとBearerトークンを要求します。これは少人数の動作確認用です。一般公開には利用者認証・利用者別上限が必要です。AWS側はまだAPI・DBのデプロイとAmplifyの `/api/*` 接続が必要です。

API仕様: [楽天市場商品検索API 2026-07-01](https://webservice.rakuten.co.jp/documentation/ichiba-item-search)。実キーを使う疎通確認は設定後に行います。

### OpenAIで実商品の候補を探す

サーバーの `.env` に追加します。キーが未設定でも既存の商品URL確認は起動でき、候補取得は未設定エラーを返します。キーはフロントやGitに置きません。

```dotenv
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
OPENAI_MODEL=gpt-6-luna
```

OpenAIのResponses APIとStructured Outputsを使い、利用者が入力した用途・条件から検索語を1つ作ります。楽天APIを1回呼び、最大10件から重複と購入不可の掲載を除き、最大6件を表示します。AIが商品URL・価格・在庫を生成する経路はありません。単一の検索語による検索候補であり、全条件への適合・同一製品・SKU・最安値を確認した結果ではありません。

現在は楽天情報のAI送信権限を許可していないため、OpenAIには利用者自身の要望だけを送ります。楽天の商品名・価格・説明などをOpenAIやJevへ送らず、Jevの評価結果やAIによる推薦理由は表示しません。Responses APIは `store: false`、出力256トークン以内、12秒のタイムアウトです。APIキー・モデルの権限・利用制限・拒否・未完了・不正な応答では候補を生成しません。

APIをdotenvx経由で起動する場合（このPCではCLI導入済み）、プロジェクトルートで実行します。

```powershell
rtk mise exec -- pnpm --filter @app/api exec tsc --noEmit false
rtk mise exec -- dotenvx run -f .env --overload --strict -- node apps/api/dist/apps/api/src/local.js
```

`--overload` は既存の環境変数よりプロジェクトの `.env` を優先します。この実行環境から継承されたOpenAIキーはローカル起動時に除外しており、プロジェクト用キーの設定待ちです。

画面の「接続設定」に動作確認用トークンを入力し、「用途・条件」に商品カテゴリを含めて「候補を探す」を押します。APIは認証付き `POST /api/candidates` です。表示期限後は再取得が必要です。キー設定後の再起動で有効になります。実OpenAIキーでの疎通・課金は設定後に確認します。

公式仕様：[Responses APIのStructured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。

Node.js / pnpm は `mise.toml` に固定。workspace対象は `apps/*` と `packages/*` です。パッケージは必要になった時点で追加し、各tsconfigから `tsconfig.base.json` の厳格設定を継承します。

## タスク

| コマンド                   | 内容                                   |
| -------------------------- | -------------------------------------- |
| `mise run lint`            | 型情報付きESLint・依存境界、警告0件    |
| `mise run lint:fix`        | Lint自動修正                           |
| `mise run format`          | Oxfmt整形                              |
| `mise run format:check`    | 整形確認                               |
| `mise run typecheck`       | TypeScript・各workspaceのtypecheck     |
| `mise run knip`            | 未使用ファイル・export・依存検査       |
| `mise run test:guardrails` | 違反が期待したruleIdで検出されるか検査 |
| `mise run verify`          | 上記の読み取り専用検査を順に実行       |

同じタスクは `mise exec -- pnpm <タスク名>` でも実行できます。未使用変数検査はESLintに集約し、整形・import順はOxfmtに集約します。`eslint-disable` は無効、型アサーションは `as const` のみ許可。例外は中央設定で管理します。

依存境界は添付方針のweb/API/worker/contracts/api-client/backendに設定済みです。WebにはNext.jsとReact Hooksの推奨規約を追加し、Hooksの条件付き呼び出し・依存配列の不足をエラーにします。

アプリ内のJavaScript、未分類コード、直接fetch、変数を使うdynamic import、初期化を断定する `!`、Lint・Formatterの無視コメントも禁止します。生成ファイルの除外は生成処理と整合性検査を導入するまで作りません。宣言ファイルも型検査します。

Lintは業務ロジックの正しさ、外部データ検証の妥当性、深い不変性、意味のない抽象化までは保証しません。これらは機能実装時のテストとレビューで検証します。

## 設定の保護

CODEOWNERSとCIを用意しています。マージを強制的に止めるには、GitHub側でmainのPR必須・Code Ownerレビュー必須・ステータスチェック `verify` 必須・迂回制限を別途有効にする必要があります。CODEOWNERS単体では保護されません。

設定仕様: [typescript-eslint](https://typescript-eslint.io/blog/project-service/)、[JS Boundaries](https://www.jsboundaries.dev/docs/rules/dependencies/)、[Oxfmt](https://oxc.rs/docs/guide/usage/formatter/config-file-reference)、[mise tasks](https://mise.jdx.dev/tasks/)。
