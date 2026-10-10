# 実装状況

更新: 2026-10-07。

| 機能             | 実装                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| 画面             | 商品URLを送信し、自動カテゴリ判定。曖昧な場合だけ選択。条件・トークン・取消・出典展開の操作なし       |
| 比較表           | 入力商品＋最大5候補。画像と価格（円）、総合・数値評価軸（100点）、欠損は「—」                         |
| カタログ         | 6カテゴリと数値評価軸をbackendに集約。APIクライアントと静的生成で同じ定義を使用                       |
| プロバイダ       | URL・ジャンル・取得・補完・成果リンク・利用権限を委譲。実API接続は楽天市場のみ                        |
| 検証・抽出       | 新品、URL完全一致、商品同定、引用、期限を検証。曖昧な容量だけ任意のJev Choiceを1回                    |
| 数値比較         | 確認済み数値の相対スコアと重み付き平均。CPUや文字情報の点数は作らない                                 |
| 公開ゲートウェイ | catalog・detect・開始・読取のみ。Bearerはサーバー保持。高コストPOSTをIPごとに1分6回／インスタンス制限 |
| 非同期ジョブ     | 冪等な開始、アクセスキー、所有者・revision・期限による制御。進捗と期限内の結果を復元                  |
| 内部API          | 条件検証、保護された取消、同期互換と既存の充電器・モニター診断を保持                                  |
| 保存             | Firestore作成トリガー、再試行と所有期限、許諾に基づく結果保存、Timestamp TTL                          |
| 公開ページ       | 短い静的HTMLとナビゲーション、本番canonical・sitemap、一時結果のnoindex。Xserver配置対応              |

受け入れ確認は `rtk mise run verify`。ビルド後のAPI接続確認は `rtk mise exec -- node tooling/verify-comparison-flow.mjs`、公開HTMLの生成と自己検証は `rtk mise exec -- node tooling/build-site.mjs`、配布物確認は `rtk mise run firebase:package` です。検査では外部APIを置換します。実キーによる充足率・抽出精度・広告成果・費用は未測定です。

共有キャッシュ、新しい認証基盤、全インスタンス共通の利用者別上限、収益計測、WordPress移行は対象外です。依存追加や検査の緩和はありません。

契約は[比較フロー](comparison-flow.md)、方針は[商品仕様](product-specification.md)、追加方法は[カテゴリ・プロバイダ拡張](category-provider-extension.md)、公開HTMLは[Xserver手順](xserver-static-site.md)、起動と基盤設定は[README](../README.md)と[Firebase手順](../infrastructure/README.md)を参照してください。
