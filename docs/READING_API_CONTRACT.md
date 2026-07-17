# 統合鑑定API契約（設計中）

## Endpoint

将来の入口は `POST /reading/generate` を想定します。現時点ではHTTP/Lambda handler、API Gateway、AWS接続は未実装です。

## 認証と信頼する値

有料modeでは `Authorization: Bearer <token>` を検証し、token由来の `user_id` で会員情報を照会します。bodyの利用者ID、plan、契約状態、deep権利、履歴属性、時刻は信用しません。

`Idempotency-Key` は小文字canonical表現のUUID v4を1操作につき1つ必須とします。前後空白、大文字、複数値、カンマ結合値は拒否します。今回実装するのは形式検証のみで、保存、予約、重複応答は未実装です。

## Request

```json
{
  "name": "表示名",
  "birth_date": "2000-01-01",
  "question": "相談内容",
  "requested_mode": "light"
}
```

| 項目 | 必須 | 仕様 |
|---|---|---|
| `name` | 必須 | trim後1〜80 Unicode code points。NUL・制御文字は拒否 |
| `birth_date` | 必須 | `YYYY-MM-DD`完全一致、実在日、1900-01-01以降、サーバー確定日以前 |
| `question` | 任意 | trim後空なら未指定。最大2,000 Unicode code points。改行可、NUL拒否 |
| `requested_mode` | 任意 | `free` / `light` / `deep` の小文字完全一致 |

`gender` は現在のサーバー鑑定エンジンの入力・計算に存在しないため、このAPIでは受け付けません。互換用metadataとしても保持しません。

未知フィールド、camelCase別名、`user_id`、`plan`、`subscription_status`、`deep_enabled`、`today`、履歴・課金・Stripe・AWS属性は入力不正として拒否します。`today` はクライアントから受け取らず、サーバーが `Asia/Tokyo` の暦日として決定します。

`requested_mode` 未指定時は、既存の `getDefaultReadingMode()` を使用します。premium activeでも標準はlightです。deepは有効な権利があり、かつ明示指定された場合だけ許可します。正しいmode名でも権利がなければfreeへ黙ってfallbackせず拒否します。

## PreparedReadingCommand

HTTP層の後段へ渡す内部コマンドは、検証済み入力、token由来userId、解決済みmode、サーバー日付だけで新規構築します。raw body、会員item、メール、token、gender、履歴属性を含めません。現段階ではこのコマンドを作るだけで、鑑定エンジンとhistoryは実行しません。

## Error contract

| HTTP | code | 条件 |
|---:|---|---|
| 400 | `READING_REQUEST_INVALID` | body型、未知・特権field、name等の形式不正 |
| 400 | `READING_INPUT_TOO_LONG` | name / question上限超過 |
| 400 | `READING_BIRTH_DATE_INVALID` | 生年月日の形式・実在性・範囲不正 |
| 400 | `READING_MODE_INVALID` | mode列挙外・表記不正 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | header未指定 |
| 400 | `IDEMPOTENCY_KEY_INVALID` | UUID v4 canonical形式不正 |
| 403 | `READING_MODE_NOT_AVAILABLE` | 正しいmodeだが現在の会員権限では利用不可 |
| 500 | `INTERNAL_ERROR` | 想定外の内部エラー |

公開エラーは固定 `code`、固定 `message`、`request_id` だけを返します。内部message、stack、入力値、token、userId、Idempotency-Keyは返しません。

## 未実装

- HTTP/Lambda handler、API Gateway、AWS接続
- engine実行、結果生成、history保存
- idempotency record、request hash、processing/completed/failed、TTL
- deep権利の予約・消費・返却
- rate limit、一般公開、UI接続
