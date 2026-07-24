# 有料鑑定 非同期jobコア Phase 1 実装証跡

作成日: 2026-07-24  
対象: `feat/reading-async-job-core`  
開始main: `d2a15173c6bf28c9c95262e18e0cff77a1b0ab84`

## 状態

```text
ASYNC_CORE_SOURCE: IMPLEMENTED_NOT_DEPLOYED
STATUS_POLLING: NOT_IMPLEMENTED
IAC: NOT_IMPLEMENTED
STAGING: NOT_PROVISIONED
LIMITED_PAID_BETA_GATE: BLOCKED_BY_STATUS_IAC_AND_STAGING
```

この証跡はローカルsourceとmock/adapter testの結果です。AWS上での稼働、本番対応、限定β利用可、IAM検証済みを意味しません。

## 実装境界

- free: 既存の同期200を維持
- light/deep: `READING_ASYNC_PAID_ENABLED === "true"`の場合だけ非同期受付
- request: auth、membership、validation、idempotency precheck、mode別SQS送信、acceptance transaction、202
- queue message: `schema_version`とopaque `job_ref`だけ
- acceptance: Rate Limitを1回計上。deepはJST月間枠を予約。concurrencyは未取得
- worker claim: jobとconcurrencyを同一transactionで条件付き取得
- worker execution: canonical engine、mode別renderer、allow-list結果のstaging、terminal transaction
- completed: job/history/idempotency確定、deep枠消費、owned concurrency解放
- failed: safe category確定、deep枠解放、owned concurrency解放
- transient: jobをQUEUEDへ戻してconcurrencyだけ解放。Rate Limitとdeep予約は維持
- duplicate: active lease、COMPLETED、FAILEDではproviderを再実行しない
- orphan: job不在60秒未満はretry、60秒以降はproviderを呼ばずack
- request artifact: Bedrock Runtime client pathを含まない

## セキュリティ境界

- queueへraw user ID、氏名、生年月日、質問、token、Idempotency-Key、fingerprint、model ID、prompt、鑑定本文を送らない
- public responseへ`job_ref`、owner情報、内部DynamoDB keyを返さない
- encrypted-at-restを前提とするjob itemだけにtoken由来owner IDとvalidated canonical inputを保持
- safe auditへraw owner ID、`job_ref`、history ID、lease owner、queue URL、receipt handle、生AWS errorを記録しない
- SQS/DynamoDB SDK clientは`maxAttempts: 1`

## 検証対象

- `tests/readingAsyncAcceptance.test.mjs`
- `tests/readingAsyncContract.test.mjs`
- `tests/readingAsyncDynamoPersistence.test.mjs`
- `tests/readingAsyncWorker.test.mjs`
- `tests/readingAsyncArtifacts.test.mjs`
- `tests/readingApiHandler.test.mjs`

## ローカル検証結果

```text
Node.js: 22.23.1
ALL_TESTS: 156 passed / 0 failed / 0 skipped
ASYNC_TESTS: 20 passed / 0 failed / 0 skipped
ASTRO_BUILD: PASS
TYPESCRIPT_NO_EMIT: PASS
READING_SERVER_BUILD: PASS
READING_FOUNDATION_BUILD: PASS
READING_API_BUILD: PASS
LIGHT_WORKER_BUILD: PASS
DEEP_WORKER_BUILD: PASS
GIT_DIFF_CHECK: PASS
SECRET_SCAN: PASS (34 changed/untracked files, production-like match 0)
NPM_AUDIT_OMIT_DEV: critical 0 / high 6 / moderate 2 / low 1 / total 9
```

Node.js 22.23.1は一時実行環境から使用し、全テストと全buildを同じversionで再実行しました。`@aws-sdk/client-sqs`を既存AWS SDKと同じ`3.1089.0`で追加した後も、production audit件数は作業開始時のbaselineから増えていません。`npm audit fix`は実行していません。

## 未実装・未実施

- status/history detail API
- UI polling
- IaC
- staging resourcesとleast-privilege IAM
- SQS event source mapping、DLQ、alarm
- AWS／Bedrock／DynamoDB E2E
- deploy、feature flag有効化、一般開放
