# 統合鑑定API契約案

## 1. Endpoint

第一候補は`POST /reading/generate`です。実装時は既存API Gatewayの命名、stage、許可Originを確認して最終決定します。現リポジトリにはAPI Gateway/IaC定義がないため、URLは未確定です。

## 2. 認証と信頼する値

有料modeは`Authorization: Bearer <token>`必須です。既存HMAC tokenの署名、`iat`、`exp`、`user_id`を検証し、token由来user_idでusersテーブルを読みます。bodyのuser_id、plan、契約状態、deep権利は無視・拒否します。

`Idempotency-Key`はUUID v4形式、1操作につき1つ必須です。tokenや秘密値をキーに含めません。

## 3. Request

```http
POST /reading/generate
Authorization: Bearer <token>
Idempotency-Key: 123e4567-e89b-42d3-a456-426614174000
Content-Type: application/json
```

```json
{
  "name": "表示名",
  "birth_date": "2000-01-01",
  "gender": "unspecified",
  "question": "相談内容",
  "requested_mode": "light"
}
```

各文字列は前後空白を除去し、長さ、日付、列挙値、総bodyサイズをサーバーで制限します。具体的上限は既存画面と法務・運用確認後に確定します。余分な権限属性は400とします。

不明な`requested_mode`はfreeへ黙って落とさず422です。正しいmodeだが権限不足は403です。inactive会員はfreeのみ許可します。有料APIでは未ログインfreeを扱わず401とし、未ログインfree統合はレート制限・履歴方針決定後の別契約にします。

## 4. Response

```json
{
  "history_id": "reading-uuid",
  "resolved_mode": "light",
  "status": "completed",
  "result": {},
  "created_at": "2026-07-17T00:00:00Z"
}
```

レスポンスは表示に必要なDTOだけとし、users項目、権利内部値、DynamoDBキー、入力ハッシュ、秘密情報を返しません。

## 5. Error contract

| HTTP | code | 条件 |
|---:|---|---|
| 400 | `INVALID_INPUT` | 入力・header形式不正、余分な権限属性 |
| 401 | `UNAUTHORIZED` | tokenなし・不正・期限切れ |
| 403 | `MODE_NOT_ENTITLED` | 正しいmodeだが権限なし／inactive |
| 404 | `USER_NOT_FOUND` | token user_idの会員レコードなし |
| 409 | `REQUEST_IN_PROGRESS` | 同一keyがprocessing |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一keyで入力ハッシュ不一致 |
| 422 | `UNKNOWN_MODE` | mode列挙外 |
| 429 | `RATE_LIMITED` | user/IP/mode制限超過 |
| 500 | `PERSISTENCE_FAILED` | 状態・履歴確定失敗 |
| 502 | `GENERATION_FAILED` | engine実行失敗 |

エラー本文は`code`、安全なmessage、`request_id`、再試行可否だけを返します。

## 6. 再送と再生成

- completed済み同一key・同一入力：200で同じ確定結果を返す。
- processing中：409と`Retry-After`。新規生成しない。
- 同一key・異なる入力：409。どちらも変更しない。
- failed：同じkeyでの再開可否はfailure分類とlease期限で決める。無条件再実行しない。
- resultの更新・再生成：既存履歴を上書きせず、新しいIdempotency-Keyと新しいhistory_idを使う。権利を再確認する。

## 7. mode解決

サーバーはusers正本から`plan`、`subscription_status`、`deep_enabled`を取得し、共通`getMembershipEntitlements()`と`resolveReadingMode()`を実行します。premiumの未指定modeはlight、deepは明示要求かつ正式権利ありの場合だけです。

## 8. 保存責務

統合APIがhistory_id、type、source、reading_mode、status、時刻、本文を決定します。ブラウザ生成本文を受け付けません。既存`history_save.py`は統合APIの有料結果保存先として直接公開し続けない方針です。

失敗履歴を利用者一覧に出すかは未確定です。監査用の失敗記録と利用者履歴を分離する案を優先し、個人情報を含む未完成本文は保存しません。

## 9. CORSとログ

- `Access-Control-Allow-Origin`は本番・承認済みpreviewのallow-listから一致したOriginだけを返す。
- `Authorization`と`Idempotency-Key`を許可headerへ明示する。
- 認証付き応答で`*`を使わない。
- token、生年月日、相談、本文、完全メールはログへ出さない。
- request_id、history_id、安全にHMAC化したuser識別子、mode、判定、状態、時間、deploy versionだけを記録する。
