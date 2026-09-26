# url-product-compare

商品URLから比較候補を探し、AIで条件に合う商品を比較するサービス。

現在はURL検査・製品同定・価格比較条件・成果リンクの検証境界と、Jevを使う候補評価ロジック、Solid.jsの動作確認UIとローカルAPIを実装しています。実商品API接続、ライバル探索、実データに基づくJev評価は未実装です。

## 商品同定ロジック

`packages/backend/src/comparison/investigate.ts` の `investigateProduct(input, providers, clock)` が入口です。登録済みの `ProductDataProvider` からURLを解決し、取得許諾・掲載ID・出典・時刻・製品の一致を検証します。楽天のURL規則は `providers/rakuten` にあり、別媒体はProvider登録で追加できます。

`Result` は処理失敗、`Option` は欠損を表します。掲載ID・製品IDは提供元ごとに区別し、スキーマ検証済みの `Product` と同定根拠付きの `IdentifiedProduct` は別型です。バリエーションの未確認と確認済みの非該当も区別します。価格は通貨・税・送料・在庫・数量・配送条件・取得時刻・期限が揃う場合だけ総額比較できます。取得・表示・保存・AI送信・成果リンクの許諾は独立しています。

`AffiliateProvider` は商品データProviderとは独立して注入します。成果リンクには製品・掲載・バリエーション・期限・遷移先の照合とProviderによる遷移先検証が必要です。利用できない候補を通常購入リンクで埋めません。実際の提携・遷移確認を行うAdapterはまだありません。`httpsUrl` 型はURL構文の検証のみで、外部URLを安全に取得できる保証ではありません。公開時には項目ごとの表示・保持・AI送信許諾を実契約で確認する必要があります。

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

AWSの公開構成・パッケージ作成・DB初期化は [infrastructure/README.md](infrastructure/README.md) にまとめています。Lambdaでも商品同定はデモです。Auroraには操作の成否だけを保存し、実商品データや入力URLは保存しません。

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

入力済みの `https://item.rakuten.co.jp/demo-shop/demo-product/` は架空データで商品同定まで確認できます。他のURLではエラーを表示します。価格・送料・在庫のAPIは未実装で、画面にも架空の比較結果は出しません。

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
