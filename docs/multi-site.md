# カテゴリ別の静的サイト

ハブは未実装。商品・ふるさと納税・証券を、それぞれ独立したAstroの静的サイトとしてビルドする。
公開ドメインは未確定で、サブドメインでも別ドメインでも同じコードを使える。
この変更はローカルの実装のみで、既存Cloudflare/AWSへの反映は行っていない。

| 役割         | アプリ / パッケージ                         | 開発ポート | 成果物                     |
| ------------ | ------------------------------------------- | ---------- | -------------------------- |
| 商品         | `apps/products` / `@app/products`           | 5173       | `apps/products/dist`       |
| ふるさと納税 | `apps/furusato` / `@app/furusato`           | 5174       | `apps/furusato/dist`       |
| 証券         | `apps/securities` / `@app/securities`       | 5175       | `apps/securities/dist`     |
| 共通UI       | `packages/ui` / `@app/ui`                   | —          | ソースを各アプリでバンドル |
| サービス設定 | `packages/site-config` / `@app/site-config` | —          | ソースを各アプリでバンドル |

`apps/products`・`@app/products` に商品サイトの名前を統一する。
各アプリの `/` がそのサービスの入口。商品アプリには従来の商品カテゴリ・比較方法・診断経路を維持する。
ふるさと納税・証券の画面と固有CSSは各アプリが所有する。

共通UIはサービス切替ヘッダーと基礎CSS（入力・表・ボタン・レスポンシブ対応・公開ページの表示）を提供する。
サービス名・開発ポート・URLの検証・相互リンク生成はsite-configが所有する。
ヘッダーは各HTMLの公開URLメタ情報を読み取るため、環境別の設定が他サイトのビルドに混入しない。
API通信は既存 `@app/api-client` の公開エントリだけを通し、比較処理・認証情報はbackendに残す。
新しい外部ライブラリやバージョン更新は追加していない。

## ローカル開発

まず `rtk mise run install` を実行し、各サイトを別ターミナルで起動する。

```powershell
rtk mise exec -- pnpm --filter @app/products dev --host 127.0.0.1
rtk mise exec -- pnpm --filter @app/furusato dev --host 127.0.0.1
rtk mise exec -- pnpm --filter @app/securities dev --host 127.0.0.1
```

URLは `http://127.0.0.1:5173/`、`:5174/`、`:5175/`。
既定のサイト間リンクもこの3オリジンを使う。ハブへのリンクは作らない。
APIは既存のローカルAPIを3001番で起動する。各Astroの `/api` プロキシが接続する。
`API_ALLOWED_ORIGIN` / `RENDER_EXTERNAL_URL` 未設定のローカルAPIは、この3オリジンを許可する。
明示した場合はその単一オリジンの設定を優先する。
API・ASP・AIのキーをフロントの環境変数に入れない。

```powershell
rtk mise run verify
rtk mise exec -- pnpm build:sites
```

後者は3サイトのHTML・API設定・canonical・sitemap・静的アセットを検証する。
各 `*_SITE_ORIGIN` 設定時はサイトごとの `SITE_ORIGIN` を自動選択する。
`pnpm build:sites --pages` なら3サイトすべてのPages成果物（ヘッダー・転送設定を含む）を検証する。
通常のテストやビルドは課金APIを呼ばない。

## Cloudflare Pages

同じリポジトリ・本番ブランチに接続するPagesプロジェクトを3つ作成する。
ルートディレクトリはすべてリポジトリ直下にする。

| サイト       | ビルドコマンド                    | 出力ディレクトリ       |
| ------------ | --------------------------------- | ---------------------- |
| 商品         | `pnpm run build:pages`            | `apps/products/dist`   |
| ふるさと納税 | `pnpm run build:pages:furusato`   | `apps/furusato/dist`   |
| 証券         | `pnpm run build:pages:securities` | `apps/securities/dist` |

全プロジェクトに `NODE_VERSION=24.22.1`、`PNPM_VERSION=10.34.5`、共通の `PUBLIC_API_BASE` を設定する。
さらに以下の公開URLを、末尾 `/` なしのHTTPSオリジンで設定する。

```text
PRODUCTS_SITE_ORIGIN=https://products.example.com
FURUSATO_SITE_ORIGIN=https://furusato.example.com
SECURITIES_SITE_ORIGIN=https://securities.example.com
```

上記は例示URL。実際には取得したドメイン、または各プロジェクトの本番 `pages.dev` URLを使う。
3つとも同じ値にはできない。サイト間のリンク先になるため、リモートAPI接続時・Pages上では全項目を必須にする。
各プロジェクトの `SITE_ORIGIN` には、そのプロジェクト自身の公開オリジンを設定する。
例：ふるさと納税のプロジェクトでは `SITE_ORIGIN` と `FURUSATO_SITE_ORIGIN` を一致させる。
`SITE_ORIGIN` 未設定の初期確認ビルドはnoindexになる。
証券は従来の公開保留を維持し、URL設定後もnoindex・空のsitemapとする。条件情報の確認後に別途公開判断する。

Custom domainsで各プロジェクトへ対応するホストを登録する。DNSだけの追加では完了しない。
PagesビルドはそれぞれCSP・404・公開ファイルの検査を行う。
商品プロジェクトでは旧 `/furusato[/]`・`/securities[/]` から各サイトの `/` への301を `_redirects` に生成する。
旧プロジェクト以外のドメイン移転や `pages.dev` から独自ドメインへの転送はCloudflare側で別途設定する。

Build watch pathsには対象 `apps/<site>/*` と `packages/*`、`tooling/*`、ルートの設定・lockfileを含める。
共通UIの更新時は3サイトの再ビルドが必要。まずデフォルトの全変更ビルドで運用し、必要に応じて監視範囲を絞る。
Previewはnoindexにし、APIの本番許可リストへ任意のPreview URLを自動追加しない。

## AWS側の接続許可

通常設定 `APPLICATION_CONFIGURATION.http` は従来の `allowedOrigin` に加え、`allowedOrigins` を受け付ける。

```json
{
  "allowedOrigin": "https://products.example.com",
  "allowedOrigins": [
    "https://products.example.com",
    "https://furusato.example.com",
    "https://securities.example.com"
  ],
  "globalPerMinute": 60,
  "globalPerDay": 1000
}
```

従来の単一Origin設定も互換として残す。追加分は完全一致・HTTPS・最大16件で検証し、ワイルドカードは使わない。
許可済みリクエストには、そのOrigin一つだけを `Access-Control-Allow-Origin` に返す。
認証・課金処理の制限・共有レート制限は共通APIに残り、CORSは認証の代用にはならない。

設定は通常のLambda更新手順で反映する。この変更でAWS設定やSecretは更新していない。
楽天APIの許可サイト・ASPの提携/掲載サイト登録は別の設定なので、新しい公開先に合わせて確認する。

設定・lockfile・境界ルール・生成処理・追加guardrailは人のレビュー対象。
CI・CODEOWNERS・リモート保護設定は変更していない。

参考：[Pages monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)、
[Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)。
