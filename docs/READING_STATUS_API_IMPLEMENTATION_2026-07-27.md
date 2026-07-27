# 有料鑑定 status polling API 実装記録

作成日: 2026-07-27
状態: `SOURCE_IMPLEMENTED_NOT_DEPLOYED`

```text
ASYNC_ACCEPTANCE: SOURCE_IMPLEMENTED_NOT_DEPLOYED
STATUS_POLLING: SOURCE_IMPLEMENTED_NOT_DEPLOYED
UI_POLLING: NOT_IMPLEMENTED
IAC: IMPLEMENTED_LOCALLY_NOT_DEPLOYED
AWS_STAGING: NOT_PROVISIONED
BEDROCK_E2E: NOT_EXECUTED
```

この文書は、以前の `READING_ASYNC_API_CONTRACT_PROPOSAL.md` にあるhistory ID中心のstatus候補を置き換えます。2026-07-27以降のstatus API契約は本書を正とします。

## 公開契約

### 受付

light / deepの新規受付またはQUEUED / IN_PROGRESSの冪等再送は、次の形で202を返します。

```json
{
  "request_id": "<opaque-request-id>",
  "job_ref": "<opaque-uuid-v4>",
  "status": "queued"
}
```

`reading_id`、history ID、raw user ID、DynamoDBの他の内部キーは返しません。`job_ref`は既存の暗号学的乱数UUID v4を外部受付番号として明示的に採用したものです。連番へ変更しません。

### 状況取得

```http
GET /reading/status?job_ref=<opaque-uuid-v4>
Authorization: Bearer <session-token>
```

API Gateway HTTP API payload format v2.0だけを受け付けます。`READING_STATUS_API_ENABLED`が厳密に文字列`true`の場合だけGETを有効化します。本作業では環境変数を設定していません。

QUEUED / IN_PROGRESS:

```json
{
  "request_id": "<opaque-request-id>",
  "job_ref": "<opaque-uuid-v4>",
  "status": "QUEUED"
}
```

未完了時は結果本文を返さず、`Retry-After: 3`を返します。

COMPLETED:

```json
{
  "request_id": "<opaque-request-id>",
  "job_ref": "<opaque-uuid-v4>",
  "status": "COMPLETED",
  "reading": {
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
}
```

完成結果の正本は既存history itemの`public_result`です。job itemのstaged resultはstatus応答へ利用せず、二つ目のsource of truthを作りません。会員プランが後から変わっても、本人の完成済み鑑定を読み返すstatus取得では会員権限を再消費しません。

FAILED:

```json
{
  "request_id": "<opaque-request-id>",
  "job_ref": "<opaque-uuid-v4>",
  "status": "FAILED",
  "error": {
    "code": "READING_JOB_FAILED",
    "message": "<fixed-safe-message>"
  }
}
```

内部failure category、例外message、stack、AWS request ID、Bedrock出力は返しません。

## 認証・所有権

- Bearer tokenを既存session validatorで検証する。
- token由来のserver-resolved user IDだけを使用する。
- client指定のuser IDは受け付けない。
- owner IDを既存job-ownerドメインのHMACへ変換し、保存済み`owner_ref`と定数時間比較する。
- owner不一致とjob不存在は同じ404 `READING_STATUS_NOT_FOUND`へ変換する。
- raw user ID、job ref、history IDを監査ログへ記録しない。

## 読み取り専用境界

status Lambda artifactが持つAWS data-plane commandは、強整合の`GetItemCommand`だけです。status取得では次を行いません。

- deep quotaの予約・消費・解放
- reading Rate Limitの消費
- concurrency slotの取得・解放
- job state更新
- SQS enqueue / re-enqueue
- Bedrock呼び出し
- engine実行

## CORSとfail closed

- exact origin allow-listを維持する。
- GET / OPTIONSだけを許可する。
- preflight headerはAuthorizationだけを許可する。
- wildcard origin、cross-originの不正値、複数query、未知query、body付きGETを拒否する。
- table、認証secret、audit HMAC secret、CORS、kill switchが成立しない場合は固定safe errorで停止する。

## ローカル成果物

- source: `src/server/readingStatus/`
- Lambda entry: `src/server/readingStatus/readingStatusLambda.ts`
- build: `npm run build:reading-status-handler`
- artifact: `dist/reading-status-handler/index.mjs`
- tests: `tests/readingStatusApi.test.mjs`

## 未実施

- IaCのAWS service validation、change set review、staging deploy
- AWS staging接続と実測
- UI polling
- production flag設定
- deploy、一般公開

## ローカル検証結果

```text
Node.js 22.23.1: PASS
ALL_REGRESSION_TESTS_NODE_22: 167 passed / 0 failed / 0 skipped
ALL_REGRESSION_TESTS_LOCAL_NODE: 167 passed / 0 failed / 0 skipped
STATUS_API_TESTS: 10 passed / 0 failed / 0 skipped
TYPESCRIPT_5_9_3_NO_EMIT: PASS
ASTRO_BUILD: PASS
READING_ENGINE_BUILD: PASS
READING_FOUNDATION_BUILD: PASS
READING_API_HANDLER_BUILD: PASS
READING_STATUS_HANDLER_BUILD: PASS
READING_LIGHT_WORKER_BUILD: PASS
READING_DEEP_WORKER_BUILD: PASS
GIT_DIFF_CHECK: PASS
SECRET_SCAN_HIGH_CONFIDENCE: PASS
AWS_CONNECTIONS: 0
BEDROCK_CALLS: 0
QUEUE_ENQUEUE_FROM_STATUS: 0
```

Node.js 22とTypeScript 5.9.3は一時実行し、repository dependencyへ追加していません。テストはmock adapterだけを使用し、実AWSへ接続していません。
