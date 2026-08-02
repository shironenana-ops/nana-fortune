# fincode TESTカード決済 E2E v1

作成日: 2026-08-02

対象: 白音七ローカル開発環境

商品: `voice_single`（300円・買い切り）

## 目的と境界

このv1は、fincode TEST環境でカード決済登録、公式JavaScriptによるカード決済実行、EMV 3-Dセキュア、戻り後の決済取得までを確認するためのものです。

- fincode TEST環境以外へは接続しません。
- 実カードは使用しません。公式TESTカードだけを使用します。
- カード番号、有効期限、CVC、名義は白音七サーバーへ送信しません。
- 成功しても会員状態、`extra_voice_remaining`、月次quota、履歴を変更しません。
- 既存のsubscription Webhook OrchestratorとAtomic Completionは変更しません。
- light／premiumの購入は対象外です。

## 公式仕様の正本

- TEST API: <https://api.test.fincode.jp>
- APIリファレンス: <https://docs.fincode.jp/api>
- TEST接続手順: <https://docs.fincode.jp/tutorial/test_api_exec>
- カード情報の非保持・非通過: <https://docs.fincode.jp/payment/execution>
- 3Dセキュア: <https://docs.fincode.jp/payment/fraud_protection/3d_secure_2>
- 公式TESTカード: <https://docs.fincode.jp/develop_support/test_resources>
- 公式JavaScript SDK: <https://docs.fincode.jp/sdk/js>
- UIコンポーネント: <https://docs.fincode.jp/payment/ui_component>

## 実装フロー

```text
/checkout?plan=voice_single
  -> POST /api/billing/fincode/test/register
  -> fincode TEST POST /v1/payments
  -> 公式 @fincode/js + fincode UI からカード情報をfincodeへ直接送信
  -> redirect_url（`https://api.test.fincode.jp`だけ許可）
  -> EMV 3-Dセキュア
  -> POST /fincode/test/result?payment_id=...
  -> fincode TEST GET /v1/payments/{id}?pay_type=Card
  -> shop / amount / pay_type / job_code / statusをサーバーで照合
```

登録リクエストでは公式の`idempotent_key`をUUIDv4で設定します。ブラウザの二重クリックを無効化し、同一試行の再実行では同じキーを再利用します。POSTをサーバー側で自動再試行しません。fincode側の冪等キー有効期限は公式API仕様上30分です。

## 設定

値はローカルの`.env.local`へ人間が設定します。`.env.local`はGit管理対象外です。

```text
FINCODE_TEST_PAYMENT_ENABLED=true
FINCODE_TEST_API_BASE=https://api.test.fincode.jp
FINCODE_TEST_SECRET_KEY=<TEST Secret API Key>
FINCODE_TEST_SHOP_ID=<TEST Shop ID>
PUBLIC_FINCODE_TEST_PAYMENT_ENABLED=true
PUBLIC_FINCODE_TEST_PUBLIC_KEY=<TEST Public API Key>
```

`FINCODE_TEST_SECRET_KEY`は`m_test_`、公開鍵は`p_test_`で始まるTESTキーだけを受理します。`true`以外は無効です。本番API origin、任意のAPI origin、非ローカルhostは拒否します。

## ローカル実行前ゲート

1. `.env.local`がGitに無視されていることを確認する。
2. fincode管理画面のTESTモードからキーとShop IDを取得する。
3. 実カードではなく、公式TESTカード一覧を別画面で参照する。
4. `/checkout?plan=voice_single`にTEST表示があることを確認する。
5. light／premiumではカードフォームが表示されないことを確認する。
6. ブラウザ開発者ツールで、カード情報が白音七originへ送られないことを確認する。

## 人間によるE2E試験表

| ケース | 操作 | 期待UI | 期待するfincode状態 | 重複防止 | 権利更新 | ログ安全 |
|---|---|---|---|---|---:|---|
| A | 3DS frictionless成功カード | 3DS後にTEST決済成功 | `CAPTURED` | 同一試行は同じ冪等キー | 0 | カード情報・raw応答なし |
| B | 3DS challenge成功カード | challenge完了後にTEST決済成功 | `CAPTURED` | ボタン連打不可 | 0 | 同上 |
| C | 3DS認証失敗カード | TEST決済失敗 | `CAPTURED`以外 | 新規権利なし | 0 | provider詳細なし |
| D | オーソリ／決済失敗カード | TEST決済失敗 | `CAPTURED`以外 | POST自動retryなし | 0 | provider詳細なし |
| E | 認証画面で戻る／キャンセル | 完了と表示しない | 未完了または失敗 | 再読込で照会のみ | 0 | 同上 |
| F | 決済ボタンを連打 | 1回目直後にボタン無効 | 決済登録の重複なし | browser＋provider冪等性 | 0 | 同上 |
| G | 戻りページを再読込 | TEST APIで再照会 | `CAPTURED`なら成功 | 新規登録なし | 0 | 同上 |
| H | `success=true`等を付けた偽造URL | 成功扱いしない | TEST API実値を採用 | 新規登録なし | 0 | 同上 |

## localhost returnの確認事項

公式仕様は成功・失敗の`return_url`へPOSTで戻る契約を示していますが、localhostを許可するとの明示記載は確認できませんでした。実装は同一ローカルoriginの固定URLだけを生成します。最初のTEST実行でlocalhostへのPOST returnが成立するかを確認し、成立しない場合は本番ではなくHTTPS stagingだけを次工程として設計します。3Dセキュアを省略する代替は採用しません。

## CSP・外部origin

将来CSPを導入・更新する場合もワイルドカードを使わず、少なくとも次を個別に検証します。

- `script-src`: `https://js.test.fincode.jp`
- `connect-src`: `https://api.test.fincode.jp`
- `frame-src`: 公式UIが実行時に使用する正確なTEST origin（初回ブラウザ試験で確認）
- `form-action`: 3Dセキュアの正確なredirect先とローカルreturn

現在のサイトには統一CSPがないため、このPRではサイト全体のヘッダー設計を変更しません。

## 即時停止条件

- TEST以外のAPI host、キー、Shop IDを検出した
- カード情報が白音七サーバー、Storage、ログ、Analyticsへ流れた
- 300円、Card、CAPTURE、3DS必須のいずれかが不一致
- 戻り画面のTEST API照合なしで成功表示された
- entitlement、membership、quota、historyに変更が発生した
- light／premiumの決済経路が開いた
- 公式redirect URLが`https://api.test.fincode.jp`ではない

## v1後の別工程

one-time Card webhook、購入ledger、Atomic Voice Grant、再送・冪等性を別PRで設計します。このv1の戻りページを権利付与のsource of truthにはしません。
