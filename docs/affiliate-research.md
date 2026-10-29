# アフィリエイト採用方針・調査結果

確認日: 2026-10-15、API実装と仕様は2026-10-17更新。公開資料による調査。会員限定の募集条件・報酬率、審査通過、実APIによる取得成功は未確認。登録・申請・問い合わせの送信は実施していない。最新のAPI別機能・SDK・アクセストレードの保留範囲は[調査記録](affiliate-api-research-20261017.md)を参照。

## 採用するサービス

| 登録先                                                                      | 掲載対象                                           | 登録・提携                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Amazonアソシエイト](https://affiliate.amazon.co.jp/)                       | Amazonの商品                                       | Amazonアカウントで申請。Creators APIは別途アクセス登録・認証情報が必要                     |
| [楽天アフィリエイト](https://affiliate.rakuten.co.jp/)                      | 楽天市場・楽天ふるさと納税                         | 楽天ID、掲載サイトの登録。APIは楽天ウェブサービスでアプリ登録                              |
| [バリューコマース](https://aff.valuecommerce.ne.jp/reg/affiliate_presignup) | Yahoo!ショッピング・さとふる                       | メール登録→運営者・サイト情報→審査→各広告主のWebサービス対応案件に提携→商品APIトークン取得 |
| [アクセストレード](https://www.accesstrade.ne.jp/pregist/mail)              | SBI・マネックス。追加候補は松井・三菱UFJ eスマート | メール登録→運営者・口座・サイト情報→審査→各証券会社に提携申請                              |
| [TGアフィリエイト](https://www.linkshare.ne.jp/new-registration/)           | 楽天証券                                           | TGを選択してサイト登録・審査→楽天証券に提携申請                                            |

楽天アフィリエイトとTGは別サービス。ASP登録だけでは各広告主との提携は完了しない。登録後の案件詳細が最新の成果条件となる。

Googleログインだけで完了できる登録先は確認できなかった。Gmailでのメール登録とは区別する。Amazonは[支払い情報へのアクセス時にSMS・音声電話認証](https://affiliate.amazon.co.jp/help/node/topic/GREXQPCVVKMG3D7P)がある。他サービスの電話認証の必須・不要は、公開資料のみでは断定していない。実際に認証を求められた箇所は本人操作で進める。

## 商品・ふるさと納税の取得経路

| 対象               | 取得経路                                                                                                                                                    | 本実装                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 楽天市場           | [楽天市場商品検索API](https://webservice.rakuten.co.jp/documentation/ichiba-item-search)                                                                    | 既存の認証・URL検証・ペーシングを再利用。通常商品だけを返す                                                     |
| 楽天ふるさと納税   | 同API。専用の返礼品APIではない                                                                                                                              | 名称に「ふるさと納税」がある掲載を対象とする暫定分類。新品表記を要求しない                                      |
| Yahoo!ショッピング | [公式商品検索API](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)・[VC商品API](https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api/) | 公式APIの独立SDKを追加。設定で従来VC経路と切替                                                                  |
| さとふる           | 同API。公式[広告主コード一覧](https://report.valuecommerce.ne.jp/mylink/EC_CODE/list.xls)に `jbfh4`                                                         | 寄付額・説明文を取得する。直接のさとふる公開APIではない                                                         |
| Amazon             | [Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)                                                                    | 独立SDKで検索・ASIN取得・バリエーション・成果リンク取得。アプリでは名称・画像・おすすめ出品の価格を表示用に限定 |

バリューコマースのコード一覧は2026-10-14版を確認。Yahooは `0hzmc`、さとふるは `jbfh4`。さとふるはJAN非対応。商品APIの広告主掲載と、登録後にその案件を使えることは別。説明文は最大4096文字で、米の品種・産年・配送回数などの専用フィールドはない。[API仕様](https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api/)

Yahoo公式経路はYahooのアプリIDとバリューコマースの連携設定を使用する。公式v3検索・v1商品コード詳細・API応答の成果リンクを扱うSDKを追加した。既存VC経路も残す。どちらも共通のCommerceListingへ変換するが、掲載IDは異なるため使い回さない。

### 返礼品の比較

- 米: 品種、産年、精米・無洗米、内容量、袋数、配送時期。
- 肉: 畜種、部位、産地、内容量、小分け、冷蔵・冷凍、賞味期限。
- 定期便: 1回の量、回数、間隔、合計量、初回発送。

API取得後に、米・肉・果物・魚介の種類判定、明示された項目の抽出、重量・定期便の換算、掲載間の条件照合を行う。原文の根拠を保持し、未確認・矛盾を区別する。横断比較API、許可と情報が揃う場合のJev全体評価、専用の比較画面を実装した。詳細は [commerce-api.md](commerce-api.md#返礼品の判定比較) を参照。認証後の実データによる抽出精度は未検証。同じ米・肉のカテゴリーでも同一商品とは扱わない。

### Amazonの制限

[日本向け規約](https://affiliate.amazon.co.jp/help/operating/policies/)には、価格比較時の新品最低価格、および提供される場合の中古最低価格の表示条件がある。広告コンテンツの集約・分析・抽出などには事前の書面承諾を求める条項がある。AIの学習・改善制限と、推論の可否を同一視しないが、このプロジェクトの仕様抽出・採点への包括的な承諾は得ていない。

追加確認: [OffersV2](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/resources/offersV2)はおすすめ出品のみを返し、旧APIの `Offers.Summaries.LowestPrice` は提供しない。おすすめ価格を最低価格と称して横断比較してはいけない。本実装では `priceBasis=featured_offer`、`usage.priceComparison=false`、`usage.ai=false`、`description=null` とし、他社との比較・AI抽出に投入しない。MAP制限があるか不明な場合も価格を伏せる。

認証は[公式cURL資料](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl)に基づく。API利用権と販売実績の条件は[最新の導入案内](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)で確認する。申請審査とAPI利用条件は別。

商品データの永続保存は今回行わない。Amazonの価格履歴・値下がり通知も実装しない。表示時は取得時刻・免責文・広告である旨の表示が別途必要。応答の `notices` は正式な画面表示の規約レビューに代わるものではない。

## 証券会社の位置づけ

比較するのは投資銘柄そのものではなく、NISAで投資するための口座サービス。NISAは非課税制度であり、証券会社の商品名ではない。[金融庁](https://www.fsa.go.jp/policy/nisa2/know/index.html)

初期対象はSBI・楽天・マネックス。松井・eスマートは追加候補。比較項目は取扱商品、手数料、最低積立額、対応カード、還元条件、銀行連携、サポート。広告案件は原則として証券総合口座の新規申込・開設。既存口座へのNISA追加・移管の成果対象可否は案件ごとに確認する。

| 会社       | アフィリエイトの公式根拠                                                                                                                                         | 取引等APIの位置づけ                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SBI        | [公式案内](https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=service&dir=service&file=home_affiliate.html&getFlg=on) | 外部ツール向け先物・オプション連携。口座比較カタログAPIではない                                                                                                                       |
| 楽天       | [TG](https://www.linkshare.ne.jp/tg/)                                                                                                                            | [MarketSpeed II RSS](https://marketspeed.jp/ms2_rss/)はExcel・デスクトップ環境向け                                                                                                    |
| マネックス | [アクセストレードの掲載実績](https://www.accesstrade.ne.jp/campaign/kinyu25_2)                                                                                   | [API利用規定](https://info.monex.co.jp/pdf/policy/api_kit.pdf)の範囲に従う資産情報等の連携。公開比較データの供給ではない                                                              |
| 松井       | [公式案内](https://www.matsui.co.jp/utility/etc/affiliated.html)                                                                                                 | 一般公開サイトの口座条件を取得するAPIは確認できず                                                                                                                                     |
| eスマート  | [公式案内](https://kabu.com/item/ad/affiliate.html)                                                                                                              | [kabuステーションAPI](https://www.kabu.com/item/kabustation_api/default.html)は取引向け。[利用規定](https://kabu.com/pdf/Gmkpdf/service/kabustationapiuserpolicy.pdf)に再配布等の制限 |

追加調査: [moomoo](https://jpaffiliate.moomoo.com/)は広告登録窓口があり、[OpenAPI](https://www.moomoo.com/jp/support/topic7_474)もあるが取引・市況向け。日本株のAPI対応範囲は要注意。[Saxo OpenAPI](https://www.home.saxo/ja-jp/platforms/api)も個人取引向けで、公開サイトへのデータ再配布権ではない。今回の初期掲載対象には含めない。

口座条件の比較には株価・売買APIは不要。NISA対応の有無と、ASPで現在その案件に提携できることは別。FX・暗号資産の広告案件をNISAとして紹介しない。金融商品の個別勧誘や投資助言を行う機能は作らない。[SBIの掲載上の注意](https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=service&dir=service&file=home_affiliate.html&getFlg=on)

### 更新方針（今回の実装対象外）

定期実行は使わない。比較ページへのアクセス時に確認期限を判定し、古い場合だけ公式ページを取得→Jevで変更を判定→適用日・条件を検証→保存する方針。24時間は候補の確認間隔であり実装済みの保証ではない。現行条件と将来条件を分け、初期は更新案の確認を挟む。取得失敗・低確信・矛盾は未確認として扱い、古い条件による順位付けを保留する。別のAIモデル追加は今のところ予定しない。

変動例: マネックスは[2026年3月JCB積立追加](https://info.monex.co.jp/fund/tsumitate/card-tsumitate/jcb-card/index.html)、[10月還元条件変更](https://info.monex.co.jp/fund/tsumitate/card-tsumitate/monex-card/about.html)。eスマートは[2026年7月からの還元率変更](https://kabu.com/company/pressrelease/20260601_1.html)、楽天は[2027年1月の変更を2026年9月に告知](https://www.rakuten-sec.co.jp/web/info/info20260928-01.html)。静的HTMLでも更新作業は必要。期間限定キャンペーンは初期比較に含めない。

## 楽天の銀行振込条件

[成果報酬のお支払い](https://affiliate.rakuten.co.jp/revision/payment/)で確認。個人の全額銀行振込プランは、申請月を含む直近3か月連続で、各月の確定成果報酬を3,001円以上受け取る等の条件、申請・審査がある。3か月平均の条件ではない。楽天キャッシュで3,001円以上を受け取る際の楽天カード／楽天銀行との連携条件とは別。法人の条件も別である。

## 未確認事項

- Amazon・Yahoo・さとふるの実アカウントでのレスポンス、成果反映。
- VCの `product_id` と広告主の `productCode` の対応が実際の広告データでも一致するか。現実装は不一致をエラーにし、別商品を返さない。
- 返礼品説明文に必要な属性がどれだけ含まれるか、抽出の精度・費用。
- 証券会社の公式資料に対するJevの条件・適用日判定精度。
- 各サービスの最新規約と取得・表示・AI送信・保存の権利。内部の許諾確認期限を延長することは権利取得そのものではない。
