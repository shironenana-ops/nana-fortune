# ブラウザ版・サーバー版fixture一致試験

## 目的

ブラウザから通常importする共通エンジンと、Node.js用bundleが同じ入力に対して完全に同じ結果を返すことを保証します。文字数の近似ではなく、全出力のdeep equalityとJSON文字列一致を確認します。

## Fixture

`tests/fixtures/shironeEngine/parity-inputs.json`に完全な架空データを置きます。

- free：質問なし
- light／deep：日本語相談あり
- 12月31日、1月1日、2月29日、月末
- 名前差、生年月日差、質問あり／なし
- 長めの日本語、前後空白

性別は既存エンジン入力にないためfixtureへ追加していません。実在利用者、βテスター、メールアドレスは使用しません。

## 日付とタイムゾーン

すべてのfixtureが`today`を`YYYY-MM-DD`で明示します。UTC、Asia/Tokyo、America/New_Yorkの別Node.jsプロセスで同じfixtureを実行し、結果が一致することを確認します。これによりテスト時刻、OSローカル時刻、月末・年末・うるう日の差を排除します。

実運用で日本時間の「今日」を作る責務は将来のHTTP/Lambda adapterに置きます。このPRでは日付生成処理を新設しません。

## 比較対象

出力全体を比較するため、plan、lengthRange、各sectionの順序・見出し・本文・改行、knowledgePayload、historyPayloadV2、日付、属性・数秘・バイオリズム、iconHintsを含みます。環境固有値を除外していません。

## 実行

```powershell
npm run test:reading-server
```

テストはサーバーbundleを生成し、通常import相当、同一プロセスのbundle、別プロセス・複数タイムゾーンを比較します。またbundleのimport一覧と禁止依存を検査します。

新しい入力境界や文章分岐を追加する場合はfixture JSONへ架空入力を追加します。共通エンジン変更時とサーバー入口変更時の双方で、全fixture一致を必須にします。

既知の意図的差異はありません。差異が発生した場合はサーバー公開を停止し、期待値を安易に更新せず、共通エンジン参照と基準日を調査します。
