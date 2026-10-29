# 商品・アフィリエイトAPIの調査と実装

確認日: 2026-10-17。公式資料を確認して実装。認証情報を使う実接続や成果計測、登録・提携申請は行っていない。アクセストレード国内版の詳細実装はユーザー指示で後回し。

## 対応表

| 取得元 / SDK                                  | 検索                             | 個別取得                              | 成果リンク                                    |
| --------------------------------------------- | -------------------------------- | ------------------------------------- | --------------------------------------------- |
| 楽天市場・楽天ふるさと納税 / @app/rakuten-api | searchItems                      | searchItemsのitemCode                 | getAffiliateLink（応答のaffiliateUrl）        |
| Yahoo・さとふる等 / @app/valuecommerce-api    | request: search                  | request: lookup（VCの商品ID）         | getAffiliateLink（応答のlink）                |
| Amazon / @app/amazon-api                      | request: search（SearchItems）   | request: lookup / getItems            | getAffiliateLink（GetItemsのdetailPageURL）   |
| Yahoo公式 / @app/yahoo-shopping-api           | request: search（v3 JSON）       | request: lookup（v1 XML、商品コード） | getAffiliateLink（応答のVC成果URL）           |
| アクセストレード国内版                        | Webサービス対応案件の商品APIあり | 詳細仕様は管理画面内                  | XMLの商品データに成果リンクを含む。今回は保留 |

成果リンク取得は商品APIの応答を利用する。存在しないリンク生成REST APIは作らず、APIのリンクを別ASPへ書き換えない。各SDKの入力型・応答検証・通信・認証はSDK内、掲載権利・鮮度・金額の比較意味・Jev利用はbackend側で扱う。SDKからbackendや他のSDKの内部ファイルをimportしない。

アプリでは全取得元を既存のCommerceProviderへ接続する。`POST /api/commerce` のsearch/lookupが同じCommerceListing形式（source/id/title/url/affiliateUrl/description/imageUrl/amount/condition/availability/shipping/tax/observedAt/expiresAt/usage）を返す。成果リンク専用にはAPIクライアントの `fetchCommerceAffiliateLink({ source, query })` を用意し、lookupで検証したリンクと取得時刻・期限を返す。秘密情報をブラウザーへ渡さない。

同じ返却形式であることと比較可能であることは別。商品IDは取得元ごとの掲載IDで、異なるサイトの商品IDを同一商品キーとしない。寄付額と販売価格、新品と中古、最安価格とおすすめ出品、送料不明と送料込みを同一条件にしない。既存の楽天用メイン商品比較UIへ他社を自動混在させる変更は含めず、共通の商品取得レイヤーを拡張した。

## Amazon

公式資料:

- [Creators API概要](https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/introduction)
- [PA-APIからの移行](https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/paapiv5-deprecation)
- [OAuth・HTTP仕様](https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/get-started/using-curl)
- [SearchItems](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/search-items)、[GetItems](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/get-items)、[GetVariations](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/get-variations)
- [OffersV2](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/resources/offersV2)
- [日本の運営規約](https://affiliate.amazon.co.jp/help/operating/policies/)
- [アソシエイト登録](https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/onboarding/sign-up-as-an-amazon-associate)

新設SDKはCreators APIを使用し、旧PA-APIのAWS署名方式は追加しない。認証はclient_credentialsとcreatorsapi::default、APIはcreatorsapi.amazon。認証情報3.1/3.2/3.3でOAuth取得先が変わる。日本市場のpartnerTag（末尾-22）とmarketplaceを指定する。アソシエイト登録後にCreators APIの利用申請・認証情報発行が必要。SDKはアカウントや販売実績による利用権の条件を回避しない。

画像URLと確認済みfeatures、親ASIN、バリエーション取得にも対応する。GetItemsは最大10 ASIN、検索は最大10件×10ページ。GetVariationsは子ASINを独立して保持し、バリエーション最安値を個別ASINの価格へ流用しない。

OffersV2はおすすめ出品の情報で、全出品者の新品・中古の最低価格ではない。MAP制限中・制限不明はSDKでも価格null。アプリは従来の保守的な利用設定を維持し、description=null、usage.ai=false、usage.priceComparison=false。共通データ形式へ変換しても、Amazon価格を他社との最低価格ランキングやJev採点へ入れない。これはSDKの技術的な取得可能範囲とは分けたプロジェクトの採用方針であり、すべての利用者に比較が一律禁止と断定するものではない。

## Yahoo!ショッピング

公式資料:

- [商品検索v3](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)
- [商品コード検索（商品詳細）](https://developer.yahoo.co.jp/webapi/shopping/shopping/v1/itemlookup.html)
- [Yahoo公式アフィリエイト設定手順](https://developer.yahoo.co.jp/webapi/shopping/affiliate.html)
- [アプリケーション登録](https://developer.yahoo.co.jp/start/)
- [バリューコマース商品API](https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api.html)
- [VCの広告スペースID](https://help.valuecommerce.ne.jp/aff/ad/adspace/01/)

今回追加した公式経路はYahooのアプリケーションIDを使用する。検索はShoppingWebService/V3/itemSearch、個別取得はShoppingWebService/V1/itemLookup。後者は公式XMLのフィールド定義に従い、JSONPは使用しない。出店者OAuthや売上・在庫管理APIの契約は不要な別経路である。

アフィリエイトではバリューコマースにサイト登録し、Yahooのプログラムと提携して自由テキスト広告のsid/pidを取得する。公式手順では、広告URLに空のvc_urlパラメーターを付けたURL全体をaffiliate_idとして渡す。SDKのcreateYahooAffiliateIdが公式形式のAPIパラメーターを用意し、リクエスト時に1回だけURLエンコードする。エンコード済み文字列や単独のIDは受け付けない。個別商品のリンクは合成せずAPIから取得し、応答のsid/pid（またはvs/vp）と商品への遷移先を照合する。backendは自サイト設定とも再照合する。

v3検索から商品状態・税込区分・在庫・送料区分を取得できる。v1詳細の公開フィールドには商品状態がないため、新品・中古はunknownに戻す。送料区分2だけ送料込み、区分1・3は総額未確認とする。ポイントや会員価格を勝手に差し引かない。1秒1回の詳細API制限を考慮し、同じクライアントの検索・取得は1.1秒間隔で共有する。

既存のValueCommerce経路も維持する。COMMERCE_CONFIGURATION.yahooにapplicationIdを置くと公式Yahoo経路、従来のtokenならValueCommerce経路。両方を混在させた設定は拒否する。lookupキーは公式経路がYahoo商品コード、従来経路はVC商品IDであり、互換とは扱わない。

## アクセストレード（保留）

公式資料:

- [Webサービス](https://www.accesstrade.ne.jp/faq/detail/96)
- [APIリファレンス](https://www.accesstrade.ne.jp/faq/detail/528)
- [ws_idの確認](https://www.accesstrade.ne.jp/faq/detail/98)
- [商品データCSV](https://www.accesstrade.ne.jp/faq/detail/527)
- [国内API仕様へのログイン先](https://member.accesstrade.net/atv3/redirect/webserv_api_reference.html)
- [海外APIの国別エンドポイント](https://support.accesstrade.global/api/api-endpoints.html)

国内の公式FAQは商品データに成果リンクを含むXML APIと、提携済み案件のCSV取得を案内している。ws_idはサイトごと。APIリファレンスへ進むと管理画面ログインが必要となり、今回エンドポイント・認証形式・XMLスキーマ・NISA案件の対応有無までは確認できなかった。

海外版ACCESSTRADEの公開JSON APIを国内版の仕様として流用しない。証券会社の口座開設案件に商品APIがあるとも仮定しない。ユーザー指示でSDK・ネットワーク実装は後回しとし、未確認URLを呼ぶスタブは作成していない。

## 検証と設定

各SDKの単体テストは模擬通信を使用し、実アカウントや課金は不要。商品とリンクの対応・誤った追跡タグ・不正URL・期限と認証・429・応答サイズ・UTF-8分割・中断を検証する。Yahoo XMLはDTD・外部実体・不正な名前参照・タグや属性の重複を拒否する。HTTPテストではSDKから共通取得APIへの変換と、許諾期限が通信中に切れた場合も検証する。

設定例は[commerce-api.md](commerce-api.md#設定)。実接続・広告の成果計測には、本人によるサービス登録・提携審査・API認証情報の発行が残る。定期実行・データ永続保存・デプロイは実施しない。
