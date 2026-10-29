# @app/jev-api

[TypeSafe Jev API](https://docs.typesafe.ai/api)の独立したHTTPクライアント。外部npm依存なし。backend・商品・比較・DB・フレームワークへの依存なし。ESMのJavaScriptと型宣言をビルドするpnpm workspaceパッケージ。

```ts
import { createJevClient } from "@app/jev-api";

const client = createJevClient({ apiKey: "API_KEY", model: "jev-1.13.0" });
const result = await client.evaluate({
  state: { fact: "example" },
  questions: {
    category: { type: "choice", instructions: "Choose a label", criteria: { a: "A", b: "B" } },
    level: { type: "score", instructions: "Rate the fact", criteria: ["low", "high"] },
    relevant: { type: "noul", instructions: "Is this relevant?" },
  },
});
```

確認日: 2026-10-17。公式API仕様を参照。テストは模擬応答のみで、新たな有料API呼び出しは実行していない。状態・指示・評価基準は呼び出し側が与える。文章生成用の機能は追加していない。

## ライブラリの担当

- `POST https://api.typesafe.ai/v1/systemone`、Bearer認証、`{model, state, questions}` のJSON送信。
- 固定バージョンの `jev-x.y.z` モデルを指定。最新モデルへの暗黙の切替なし。環境変数やファイルは読まず、設定・fetcherを呼び出し元から渡す。
- Choice / Score / Noul の入力形式、JSONとして送れる値・有限数・64階層・32MiB上限を検証。ライブラリの質問数上限は512、Choiceは1〜255選択肢、Scoreは2〜10段階。利用モデル固有の上限は別途満たす必要がある。
- 応答のモデル一致、質問ID集合とanswersの一致、256KiBのストリーム上限を検証。回答ごとの値・確率分布・引用整合性・採用閾値は利用側が検証する。1問の不正値で他の有効な回答を失わないよう、answersの値はunknownとして返す。
- 402・401/403・429・通信失敗・不正応答を区別。生の上流例外・認証情報は返さない。リダイレクト禁止・再試行なし。デフォルト8秒、`timeoutMs` で1〜60,000ms。呼び出し元のキャンセルはAbortErrorとして伝播する。

戻り値は `{tag:"ok",value:{model,answers}}` または `{tag:"err",error:...}`。商品向けの質問文、比較項目の選定、信頼度閾値、項目ごとの採点解釈、合計点、順位付けはbackend側に残す。既存のJevモデル・比較プロンプト・呼び出し回数を変更しない。

## 利用・ビルド

利用側に `"@app/jev-api": "workspace:*"` を追加し、公開エントリからimportする。

```text
mise exec -- pnpm --filter @app/jev-api build
mise exec -- pnpm --filter @app/jev-api test
```

ビルド後にこのディレクトリで `pnpm pack` すれば他プロジェクトへtgzとして渡せる。公開レジストリへのpublishは行っていない。ブラウザーへAPIキーを渡さない。
