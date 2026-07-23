# 非同期有料鑑定API契約案

状態: `PROPOSED_NOT_IMPLEMENTED`

この契約はlight／deep用の候補です。freeは既存の同期200契約を維持します。

## POST /reading/generate

認証、CORS、入力schema、Idempotency-Key、会員権限は既存契約を維持します。light／deepの新規受付が確定した場合だけ202を返します。

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
X-Request-Id: <opaque-request-id>
Retry-After: 3
```

```json
{
  "request_id": "<opaque-request-id>",
  "reading_id": "<opaque-history-id>",
  "status": "queued"
}
```

公開bodyへjob table key、raw user ID、owner token、queue URL、model ID、prompt、入力値を含めません。

202は次をすべて満たす場合だけ返します。

- queue送信成功
- job／processing history／idempotency／Rate Limitのtransaction成功
- deepでは月間枠予約成功
- response deadline内に受付結果が確定

queue送信失敗、transaction失敗、deadline超過では202を返しません。

## 再送

| 状態 | 同じkey・同じ入力 | HTTP |
|---|---|---|
| QUEUED | 同じ`reading_id`と`processing`を返す | 202 |
| IN_PROGRESS | 同じ`reading_id`と`processing`を返す | 202 |
| COMPLETED | 既存の完成済み公開DTOを返す | 200 |
| FAILED | 安全な失敗応答。新規実行は新しいkeyが必要 | 409または既存error mapping |
| any | 同じkey・異なる入力 | 409 |

Rate Limit、quota、worker数は再送で増やしません。

## 状態取得

初版は新しいjob endpointを増やさず、既存のhistory detail URIを安全に拡張する案を優先します。

```http
GET /history/detail?history_id=<opaque-history-id>
Authorization: Bearer <token>
```

token由来user IDとhistory ownerが一致した場合だけ、次のallow-list DTOを返します。

処理中:

```json
{
  "reading_id": "<opaque-history-id>",
  "status": "processing",
  "mode": "light",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>"
}
```

完了:

```json
{
  "reading_id": "<opaque-history-id>",
  "status": "completed",
  "mode": "light",
  "result": "<existing-public-result-dto>",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>"
}
```

失敗:

```json
{
  "reading_id": "<opaque-history-id>",
  "status": "error",
  "mode": "light",
  "error": {
    "code": "READING_GENERATION_FAILED",
    "retryable": false
  },
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>"
}
```

公開しないもの:

- raw user ID、email、DynamoDB key／内部属性名
- Bedrock error、AWS request ID、stack、prompt、モデル出力
- idempotency hash、owner token、lease、quota reservation ID
- queue receipt handle、receive count、DLQ情報

`Retry-After: 3`を初期値とし、clientは3秒、5秒、10秒、最大15秒のbackoff候補を使います。値はstaging観測後に人間が確定します。

## エラーとCORS

- 既存のexact origin allow-listを維持し、wildcard CORSへ戻しません。
- 認証失敗、権限不足、Rate Limit、quota、idempotency conflictの既存公開codeを維持します。
- status取得の存在有無から他人のreading IDを列挙できないよう、非所有と不存在の公開差を最小化します。
- polling failureを生成failureとして表示しません。clientは通信失敗とjob状態を分けます。

## 実装前gate

- contract test
- owner mismatch test
- duplicate request／duplicate queue delivery test
- queue成功後transaction失敗のorphan test
- terminal／transient failureの権利解放test
- completed後の会員ランク低下閲覧test
- raw user ID／PII／secret非漏えいtest

これらが通るまでAPIを有効化しません。
