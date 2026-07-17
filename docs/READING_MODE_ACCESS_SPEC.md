# 会員プランと鑑定モードの接続仕様

## 1. 目的

白音七の会員プランと鑑定モードを別の概念として扱い、画面表示やURLだけで利用権が昇格しない接続方法を定めます。この文書は次PRの実装仕様であり、現時点ではlight／deep鑑定を開放しません。

## 2. 用語

- 会員プラン：`free`、`light`、`premium`
- 鑑定モード：`free`、`light`、`deep`
- 希望モード：利用者が画面で選んだモード
- 利用可能モード：認証済みの会員状態から許可されるモード
- 実行モード：希望モードと利用権を照合した後、実際にエンジンへ渡すモード

premiumは会員プランであり、鑑定モードではありません。premium会員を自動的にdeepへ固定しません。

## 3. 利用可能モード

| 状態 | free | light | deep | 標準モード |
|---|---:|---:|---:|---|
| 未ログイン | 可 | 不可 | 不可 | free |
| free会員 | 可 | 不可 | 不可 | free |
| light・active | 可 | 可 | 不可 | light |
| light・inactive | 可 | 不可 | 不可 | free |
| premium・active・deep権利なし | 可 | 可 | 不可 | light |
| premium・active・deep権利あり | 可 | 可 | 可 | light |
| premium・inactive | 可 | 不可 | 不可 | free |

deepは`membershipEntitlements.ts`の正式判定、すなわちpremium、active、`deep_enabled === true`をすべて満たし、利用者が明示的にdeepを選んだ場合だけ実行します。

`normal`と`member`は旧会員値としてlightへ正規化します。不明な会員値はfree相当です。不明な希望モードは拒否し、安全な表示・遷移先としてfreeへ落とします。

## 4. 現在の実行経路

- `/diagnosis`は名前、生年月日、性別を`localStorage.fortuneInput`へ保存し、`/result`へ遷移します。
- `/result`のブラウザスクリプトが`shironeEngine.ts`をimportし、`plan: "free"`で`runShironeEngine()`を実行します。
- `shironeEngine.ts`にはfree／light／deepと各モード用セクションがすでにあります。クライアントバンドルへ含まれるため、開発者ツールでJavaScriptを操作できる利用者は、UIを隠すだけならlight／deep生成を試行できます。
- `/result`は結果本文をクライアントで組み立て、履歴保存APIへ送ります。現在の保存形式は`type: "normal"`、`source: "daily_engine_v1"`です。
- 履歴保存APIはセッショントークンから`user_id`を確定しますが、送信された結果本文と鑑定モードをサーバー側で再生成・照合しません。

したがって現状は、A「UI上の案内制御」とB「通常操作への制御」は次PRで改善できますが、C「JavaScript改変にも耐える強い権限制御」は実現していません。light／deepを有料権利として強制するには、認証済み会員情報を使うサーバー側の検証・生成・保存境界が別途必要です。

## 5. 既存モジュールの役割

- `membership.ts`：会員プラン値の正規化と表示情報
- `membershipEntitlements.ts`：契約状態、deep権利、音声枠の正式判定
- `accessPolicy.ts`：旧来の静的なプラン別一覧。premiumならdeepを含めるため、実行権限の正本には使用しない
- `readingModeResolution.ts`：共通権限判定を使い、希望モード、利用可能モード、実行モードを分離する純粋関数

## 6. 信頼境界

URLパラメータ、`localStorage`のplan、画面上のボタン、旧Stripe属性は権限情報として信用しません。次PRでは、Bearerトークンで認証したAPIから取得した会員属性を`resolveReadingMode()`へ渡します。

UIは選択肢の案内を担当します。実行直前には同じ会員属性を使って再解決します。将来サーバー実行へ移す場合も、サーバー側で再度解決します。

## 7. 過去鑑定

会員ランクや契約状態が変わっても、すでに生成・保存された鑑定本文は閲覧可能とします。「一度届けた鑑定はユーザーの資産」という方針を維持し、新規生成権限と過去履歴の閲覧権限を分離します。

## 8. 単発利用権の将来接続点

将来、単発deep利用権を追加する場合は`membershipEntitlements.ts`へ正式な権利と残数を追加し、`readingModeResolution.ts`はその結果だけを参照します。URL、Storage、購入完了画面だけで権利を付与しません。権利消費はサーバー側で冪等に行います。

## 9. 次PRの接続案

1. `/diagnosis`で希望モードを選べる場合も、入力値とは別の一時的なUI状態として扱う。
2. `/result`で認証済み会員情報を取得する。
3. 希望モードと会員情報を`resolveReadingMode()`へ渡す。
4. `allowed === false`ならlight／deepを実行せず、理由を表示してfreeへ案内する。
5. `allowed === true`の場合だけ`resolvedMode`を`runShironeEngine()`のplanへ渡す。
6. 履歴のtype／sourceは正式仕様を別途確定するまで変更しない。

次PRの主な変更候補は`src/pages/diagnosis.astro`、`src/pages/result.astro`、会員情報取得処理、関連テストです。準備中の`premium/light.astro`と`premium/deep.astro`は、強い権限制御の設計ができるまで開放しません。

## 10. 次PRのテスト項目

- 未ログイン、free、light、premium、inactiveの各表示と実行モード
- premiumの標準がlightであること
- deepが明示選択かつ正式権利ありの場合だけ選ばれること
- URL、Storage、DOM改変だけでは昇格しないこと
- 認証失敗・会員情報取得失敗時にfreeへ安全に閉じること
- `/result`の既存free鑑定と履歴保存が退行しないこと
- 過去の保存済み鑑定が契約変更後も閲覧できること
- light／deep履歴のtype／sourceが正式仕様と一致すること

強い権限制御が必要な有料鑑定をクライアント生成のまま開放するかは、次PR着手前に再判断します。
