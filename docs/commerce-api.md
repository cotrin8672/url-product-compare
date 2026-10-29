# 商品・返礼品の取得API

2026-10-17更新。商品・返礼品の検索・取得と、返礼品の項目抽出・数量換算・比較判定、`/furusato/` の検索・比較画面を実装する。既存 `/api/detect`・`/api/comparisons` の比較・採点にはまだ接続しない。証券会社の更新、アカウント登録は対象外。

## エンドポイント

- `GET /api/commerce/sources`: 5つの取得元と認証設定の有無。キーや契約情報は返さない。`configured` は実APIの接続成功・許諾有効・審査通過の保証ではない。
- `POST /api/commerce`: 検索・1件取得。公開ゲートウェイ経由では既存の同一オリジン検証・IP単位レート制限を適用。サーバー内の直接呼び出しはBearerが必要。
- `POST /api/furusato/compare`: 楽天ふるさと納税・さとふるの掲載を2〜6件取得して横断比較。同じ認証・オリジン検証・レート制限・本文4KiB上限を適用。

```json
{ "source": "satofull", "operation": "search", "query": "米 10kg", "page": 1, "limit": 10 }
```

`source` は `rakuten / yahoo / amazon / rakuten_furusato / satofull`。検索語はUTF-8で128バイトまで、ページ1～10、件数1～10。実際の取得はリクエスト時だけ行う。定期実行・バックグラウンド更新・商品データ永続保存なし。

```json
{ "source": "amazon", "operation": "lookup", "query": "B000000001" }
```

lookupのquery: 楽天は商品URL（APIのitemCodeとURL末尾のIDを同一視しない既存処理を使用）、AmazonはASINまたは `https://www.amazon.co.jp/dp/ASIN`、Yahoo・さとふるは商品APIが返した `id`。VCのID対応は実データ未検証。不一致を別商品で補完しない。lookupではpage/limitを省略する。

結果は既存と同じ `{ "tag": "ok", "value": ... }` / `{ "tag": "err", "error": { "code": ... } }`。成功は `listings / total / page / limit` を返す。各掲載に取得元・ID・名称・元URL・成果リンク・説明文・金額・取得時刻・期限・利用範囲を付ける。エラーに認証情報や生の上流応答は含めない。

画面からはAPIクライアントの `fetchCommerceSources`・`fetchCommerceListings` を使う。成果リンクだけの取得は `fetchCommerceAffiliateLink({ source, query })` で同じlookupを呼び、リンクと取得時刻・有効期限を返す。取得元・金額種別・期限・成果リンクの遷移先・Amazonの利用範囲をクライアントでも検証する。

- `amount.kind=purchase / donation`。返礼品の寄付額を通常商品の販売価格と混ぜない。
- `condition=not_applicable` は返礼品専用。通常商品を新品と決めつけない。VC Yahooは状態が不明なので `unknown`。
- `usage.priceComparison` はデータ利用範囲であり、同一商品・状態・税込総額の比較成立を保証しない。
- `usage.store=false`。データの有効期限は最大15分と許諾確認期限の短い方。15分は内部の鮮度上限で、上流規約の包括的な許可を意味しない。
- `usage.ai` は明示的な確認設定に従う。Amazonは常にfalseで、商品説明も返さない。
- Amazonは `priceBasis=featured_offer`、`usage.priceComparison=false`。最低価格を取得したとは扱わない。制限価格は伏せる。
- 説明文はプレーンテキスト。画面でHTMLとして挿入しない。返礼品には下記の `furusato` を付ける。
- `imageUrl` は画像がない場合null。楽天の `mediumImageUrls`、VCの公式JSON項目 `imageLarge / imageFree / imageSmall.url` を使用する。VC SDKはHTTPSの公開ホストだけを採用し、未提供・HTTP・不正URLは画像なしとする。旧応答の未提供はクライアントがnullへ正規化する。画像は保存・再配信せず、既存の商品比較と同じ画像表示方法を使う。
- 設定なしは503 `not_configured`、期限切れは422 `source_not_authorized`。上流の不正形式・成果リンク不一致は422 `invalid_response`、401/403は503 `provider_unauthorized`、429は429 `provider_rate_limited`。存在しない取得先URLをサーバーから開かない。HTTP・別ドメインへのフォールバックはしない。

## 返礼品の判定・比較

`POST /api/commerce` の返礼品検索・取得結果には `value.furusato` を付ける。通常販売の商品には付けない。異なるサイトの掲載を比較する場合は、検索で得た掲載を次のAPIに指定する。

```json
{
  "items": [
    { "source": "rakuten_furusato", "query": "https://item.rakuten.co.jp/SHOP/ITEM/" },
    { "source": "satofull", "query": "PRODUCT_API_ID" }
  ]
}
```

`query` は楽天の商品URL、さとふるのAPI掲載ID。本文から寄付額や説明文は受け取らず、サーバーで再取得する。全件の形式・設定を検証してから順次取得する。同じ取得元・IDの重複は拒否し、1件でも取得失敗した場合は比較結果を返さない。画面からは `fetchFurusatoComparison` を使用する。

判定フローは「API取得→種類判定→種類別の項目抽出→数量換算→掲載間の比較判定→比較時のJev採点」。検索ではJevを呼ばない。定期実行・商品ページのスクレイピングは行わない。

| 種類 | 抽出する固有項目           |
| ---- | -------------------------- |
| 米   | 品種、精米区分、産年       |
| 肉   | 畜種、部位、等級、加工状態 |
| 果物 | 種類、品種、加工・等級表記 |
| 魚介 | 種類、品種表記、加工状態   |

共通項目は産地、保存・配送温度、発送時期、賞味・消費期限、配送形式、1回の内容量、配送回数、合計内容量。APIに明記された表記を規則で抽出する。全品種・表現を網羅する辞書ではなく、対応外の返礼品や記載のない項目は未確認となる。種類は原則商品名から判定し、判定不能なら説明文の品名・名称・商品名ラベルを参照する。複数の種類に一致する場合は矛盾とする。

追加の共通項目は寄付先自治体、提供事業者、包装・小分け、原材料、アレルギー表示、サイズ・規格、申込期限。明示ラベルのある行だけを採用し、産地から自治体を推測せず、未記載のアレルギーを「なし」としない。複数の異なる記載はconflict。アレルギー表示は提供元の記載であり、安全性の独自判定ではない。VCの説明HTMLの表はラベルと値をプレーンテキストの行へ変換してから解析する。

`furusato.items` は掲載順。各要素は `source / id / category / fields / donationPerKg`。`category` と各fieldには `id / label / status / value / unit / evidence` がある。`status=known / unknown / conflict`。未確認・矛盾の値はnull、重量の単位はg、配送回数は回。`evidence` の `source=title / description` と `quote` は取得した原文の引用。全角表記を数値計算用に正規化しても引用は原文を保持する。

- `5kg×2袋` → 合計10,000g。`毎月5kg・全6回` → 1回5,000g・6回・合計30,000g。`500g×2パック×6回` → 1回1,000g・6回・合計6,000g。
- 単発の明記がなければ配送1回と推測しない。定期便の「5kg」が1回分か合計か不明なら換算しない。配送間隔や初回日を未記載から補完しない。
- 重量の食い違い、複数成分・選択容量・概量・範囲・おまけやタレ込みの曖昧な内容量は確定量にしない。栄養成分や調理例の重量は使用しない。
- `donationPerKg` は確定した寄付額÷合計kg、小数第2位まで。寄付額が範囲、不明な種類・重量、売切れ、比較利用不可の場合はnull。市場価格との還元率や品質の得点ではない。
- `furusato.pairs` は `left / right` の0始まり掲載位置、`status / reasons / unitDonationComparable`。別の種類は `incompatible`、条件の不足・相違は `partial`、必要条件を確認でき一致した場合だけ `comparable`。
- 単価比較の必要条件は同じ種類・配送形式・保存温度。加えて米は精米区分と品種、肉は畜種・部位・加工状態、果物・魚介は種類と加工状態を照合する。理由は `deliveryMode_different`、`cut_unknown_or_conflicting` 等。原産地や産年を含む全項目の一致・同一返礼品の保証ではない。
- APIクライアントも値・単位・引用元・単価計算・比較理由・掲載位置を検証する。

### Jevの比較スコア

比較APIの `furusato.scoring` は `status / calls / scope="overall" / items`。各itemは入力順の `score / rank / assessment`。返礼品全体に対するJevの評価を1件につき1つ返し、品種・産地・包装などの項目別得点やその平均は作らない。画面は画像・全体スコア・寄付額・総内容量・配送タイプ・kgあたり寄付額を表示し、それ以外の属性は「詳細項目を表示」で確認する。

専用の `createJevFurusatoScoring` が既存Jev SDKで最大1回の一括リクエストを行う。Jev設定、全掲載のAI利用許可、同一カテゴリ、確定した寄付額・総内容量・配送形式が必要。期限切れ・受付終了は採点しない。比較条件の合う組合せだけkgあたり寄付額を評価に利用する。品種・産地・自治体・種類・好みや用途による違いは、それだけで加減点しない。味・市場価格・還元率を推測せず、未確認の任意項目の多さでも減点しない。

全体評価の5段階（確率分布による中間値を含む）を25倍して0〜100点に換算する。確信度0.6未満や回答欠落が1件でもあれば全体を未採点とし、不完全な集合で順位を付けない。同点は同順位。日本語の評価理由文や紹介料による加点はない。

`status=applied / not_configured / not_authorized / needs_information / unavailable`。未設定・未許可・低確信・障害を固定点で埋めない。クライアントもoverall形式・入力の成立条件・Jevモデル・確信度・換算・順位を検証し、旧形式の項目別得点は受け付けない。実モデルの接続・利用許可は別途必要で、模擬採点を本番データとして返さない。

実APIの説明文でどれだけ項目が埋まるかは認証情報設定後に検証する。現在のテストは模擬応答による数量・矛盾・横断比較・HTTP経路の検証。

## 設定

### 再利用用APIライブラリ

楽天の通信は [@app/rakuten-api](../packages/rakuten-api/README.md)、さとふる・YahooのVC経路は [@app/valuecommerce-api](../packages/valuecommerce-api/README.md)、Amazonは [@app/amazon-api](../packages/amazon-api/README.md)、Yahoo公式経路は [@app/yahoo-shopping-api](../packages/yahoo-shopping-api/README.md)、Jevは [@app/jev-api](../packages/jev-api/README.md) に分離した。すべてbackendへ依存せず、backendが `workspace:*` で利用する。4つの商品SDKは `getAffiliateLink` も提供する。認証・クエリ・応答形式・サイズ制限はライブラリ、掲載権利・成果リンクの自サイト照合・比較データへの変換・Jevの評価基準はbackendが扱う。[公式仕様の調査記録](affiliate-api-research-20261017.md)も参照。

`mise exec -- pnpm build:api-libraries` で5つのJavaScriptと型宣言を生成する。`mise run verify`・型チェック・ローカルAPI起動・サイト生成・Firebaseパッケージ生成は必要なライブラリを先にビルドする。ブラウザーからライブラリへ直接アクセスしない。

楽天は従来の `RAKUTEN_*` 設定を使用する。許諾確認期限が切れた場合は接続しない。新規3取得元はサーバー環境変数 `COMMERCE_CONFIGURATION` にJSONを設定する。使う取得元だけ指定する。サーバーからブラウザーに渡してはいけない。

```json
{
  "yahoo": {
    "token": "VALUECOMMERCE_PRODUCT_API_TOKEN",
    "siteId": "1234567",
    "spaceId": "123456789",
    "authorizedUntil": "2026-11-01T00:00:00.000Z",
    "aiAuthorized": false
  },
  "satofull": {
    "token": "VALUECOMMERCE_PRODUCT_API_TOKEN",
    "siteId": "1234567",
    "spaceId": "987654321",
    "authorizedUntil": "2026-11-01T00:00:00.000Z",
    "aiAuthorized": false
  },
  "amazon": {
    "clientId": "CREATORS_API_CREDENTIAL_ID",
    "clientSecret": "CREATORS_API_CREDENTIAL_SECRET",
    "partnerTag": "YOUR_TRACKING_ID-22",
    "authorizedUntil": "2026-11-01T00:00:00.000Z"
  }
}
```

上記はダミー値。期日は実際の取得・表示・リンク・AI利用条件を確認した上で決める内部停止期限。勝手に延長しない。VCのsiteId/spaceIdは取得元ごとの広告スペースの値（URLのsid/pidまたはvs/vp）。返された成果リンクのID・遷移先が一致することを検証する。AI送信の権利を確認していない場合はaiAuthorized=falseを維持する。

AmazonはCreators API利用承認後の認証情報を設定する。`credentialVersion` は未指定3.3（日本）、3.1（米国）、3.2（英国）に対応し、認証情報の発行版に合わせてOAuth取得先を切り替える。取得対象は日本市場のまま。短命なアクセストークンのみメモリに保持し、商品データは保存しない。

Yahoo公式APIを使う場合は上の `yahoo` を次の設定へ置き換える。`applicationId` と従来のVC `token` の同時設定は不可。Yahoo用の提携済み広告から得たsiteId/spaceIdを、[公式手順](https://developer.yahoo.co.jp/webapi/shopping/affiliate.html)のURL形式へ変換してaffiliate_idへ渡す。完成した商品リンクはAPI応答から取得する。

```json
{
  "applicationId": "YAHOO_APPLICATION_ID",
  "siteId": "1234567",
  "spaceId": "123456789",
  "authorizedUntil": "2026-11-01T00:00:00.000Z",
  "aiAuthorized": false
}
```

任意で `affiliateId` を指定する場合は、`https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=自分のsiteId&pid=自分のspaceId&vc_url=` のような未エンコードのURLを指定する。SDKがURLエンコードを1回だけ行う。単独のサイトIDやエンコード済み文字列は指定しない。

公式Yahoo経路のlookupは検索結果の `id`（Yahoo商品コード）またはクエリー・フラグメントのない商品URL。VC経路のIDとは別物。公式経路は検索で状態を取得できるが、v1詳細の公開仕様に状態がないためlookupではunknown。画像はv3のexImage/image、v1のExImage/ImageからHTTPSの公開URLのみ採用する。条件付き送料無料は送料込みとしない。

Firebaseでは既存の `API_CONFIGURATION` JSON secretに `commerce` キーとして同じオブジェクトを追加する。独立HTTP設定のaccessTokenが必要。既存比較ジョブのworkerは新APIを実行せず、従来の楽天比較だけを扱う。

現状は認証情報未設定の取得元で実接続を試さない。保存済みの契約期限・設定を勝手に更新しない。実データによる返礼品属性充足率や紹介料の計測は、このAPIのテストとは別に確認する。

調査と登録先は [affiliate-research.md](affiliate-research.md) を参照。
