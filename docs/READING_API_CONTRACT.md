# 統合鑑定API契約（handler基盤）

## Endpoint

入口は `POST /reading/generate` とpreflight用の `OPTIONS /reading/generate` です。今回実装したのはAPI Gateway HTTP API payload format v2.0向けのNode.js 22 Lambda handler基盤です。AWSリソース、API Gateway設定、deploy、UI接続は未実装です。

`READING_GENERATE_API_ENABLED`が厳密に文字列`true`の場合だけPOST生成を開始します。未設定、空、`false`、`TRUE`、`1`、前後空白付き値は503でfail closedします。フラグ有効時も認証、会員照会、mode解決は必須です。

JSON bodyはdecoded UTF-8で16KiBまで、base64形式の場合はencoded bodyも24KiBまでです。`Content-Type`は`application/json`またはUTF-8 charsetを明示した同media typeだけを完全一致で受理します。

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

HTTP層の後段へ渡す内部コマンドは、検証済み入力、token由来userId、解決済みmode、サーバー日付だけで新規構築します。raw body、会員item、メール、token、gender、履歴属性を含めません。handlerは自前エンジンを1回実行しますが、history保存は行いません。

## Success response

成功時は200と`X-Request-Id`を返し、bodyにも同じ`request_id`を含めます。内部engine objectをspreadせず、次のallow-listだけを構築します。

```json
{
  "request_id": "...",
  "resolved_mode": "light",
  "status": "completed",
  "rendering_status": "rendered",
  "result": {
    "title": "...",
    "sections": [{ "id": "...", "heading": "...", "body": "..." }],
    "one_step": "...",
    "avoid_hint": "..."
  }
}
```

freeではBedrockを呼びません。light／deepはcanonical結果を先に確定し、既存rendererを呼びます。timeout、provider error、不正出力時に既存rendererがcanonical fallbackを返せる場合、HTTPは200を維持し`rendering_status: "fallback"`とします。生AWSエラーやfallback内部理由は公開しません。

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
| 400 | `HTTP_EVENT_INVALID` / `REQUEST_BODY_INVALID` | payload v2構造、header、JSON不正 |
| 404 | `HTTP_ROUTE_NOT_FOUND` | path不一致 |
| 405 | `HTTP_METHOD_NOT_ALLOWED` | POST／OPTIONS以外 |
| 413 | `REQUEST_BODY_TOO_LARGE` | encoded／decoded body上限超過 |
| 415 | `CONTENT_TYPE_NOT_SUPPORTED` | JSON以外 |
| 503 | `READING_API_DISABLED` | kill switchが厳密な`true`以外 |
| 500 | `INTERNAL_ERROR` | 想定外の内部エラー |

公開エラーは固定 `code`、固定 `message`、`request_id` だけを返します。内部message、stack、入力値、token、userId、Idempotency-Keyは返しません。

## 未実装・一般開放を禁止する境界

- AWSリソース、API Gateway設定、実AWS接続、deploy、UI接続
- history保存
- idempotency record、request hash、processing/completed/failed、TTL
- deep権利の予約・消費・返却
- rate limit、一般公開、UI接続

`Idempotency-Key`は形式検証だけであり、再送安全性は未完成です。in-memory Mapによる代替もありません。履歴確定、deep権利確定、会員別rate limitが揃うまで、このhandlerを有料鑑定一般開放の根拠にしてはいけません。
