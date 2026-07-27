# 有料鑑定 staging IaC 実装記録

作成日: 2026-07-27
状態: `IAC_IMPLEMENTED_LOCALLY_NOT_DEPLOYED`

```text
ASYNC_ACCEPTANCE: SOURCE_IMPLEMENTED_NOT_DEPLOYED
STATUS_POLLING: SOURCE_IMPLEMENTED_NOT_DEPLOYED
IAC: IMPLEMENTED_LOCALLY_NOT_DEPLOYED
AWS_STAGING: NOT_PROVISIONED
BEDROCK_E2E: NOT_EXECUTED
PRODUCTION: UNCHANGED
```

## 採用方式

既存repositoryにIaC frameworkがないため、新しいdependencyを追加しないAWS CloudFormation JSONを採用しました。`infrastructure/reading-staging/template.json`が正本です。AWSへ接続しないローカルvalidatorと回帰テストで、構文と重要な安全境界を検査します。

## 構築対象

- HTTP APIと明示的`staging` stage
- request / status / light worker / deep worker Lambda
- light / deep Standard queueと各DLQ
- batch size 1、partial batch response、最大同時実行5、既定無効のevent source mapping
- staging専用のusers、history、idempotency、rate/concurrency、deep quota、jobs table
- 各Lambda専用log group（30日保持）
- 4つの分離された最小権限role

全DynamoDB tableは物理名を固定せず、on-demand、暗号化、deletion protection、Retainを指定します。jobs以外はPITRを有効、jobsは既存計画どおりPITR未決定のため無効です。TTL対象tableは`expires_at`を設定します。

## timeoutとlease

| 項目 | light | deep |
|---|---:|---:|
| worker timeout | 120秒 | 240秒 |
| Bedrock timeout | 90秒 | 180秒 |
| job/concurrency lease | 180秒 | 360秒 |
| SQS visibility | 720秒 | 1,440秒 |

各workerは別Lambdaなので、単一名の`READING_CONCURRENCY_LEASE_SECONDS`もmodeごとに別値を渡します。request Lambdaでは受付時にconcurrencyを取得しませんが、設定読込をfail closedで成立させるため安全側の360秒を渡します。

## IAM境界

- request: users `GetItem`、必要tableのread/write/transaction、2 queueへの`SendMessage`。Bedrockとqueue receiveは禁止。
- status: jobs/historyの`GetItem`だけ。DynamoDB write、SQS、Bedrockは禁止。
- light worker: light queue、jobs/history/idempotency/rate、light JP profileだけ。users/deep quota/deep queueは禁止。
- deep worker: deep queue、jobs/history/idempotency/rate/deep quota、users condition check、deep JP profileだけ。light queueは禁止。
- logs: 各roleは自身の事前作成log groupへ`CreateLogStream`と`PutLogEvents`だけ。

`TransactWriteItems`はtransaction内の全table ARNをresourceに列挙します。Bedrockはprofile ARNと東京・大阪のfoundation model ARNを入力parameterで完全指定し、foundation model resourceには対応profile ARNの条件を付けます。

## 安全上の未確定事項

- exact Bedrock ARNはAWS上の対象profileを人間が確認するまでrepositoryへ固定しない。
- DynamoDBのAWS owned keyからcustomer managed KMS keyへの変更は、費用・key policy・復旧設計の人間判断待ち。
- alarms、dashboard、budget通知、artifact bucketは本templateに含めず、実resourceと通知先が確定した後の別change setとする。
- staging users tableは空で作成される。実ユーザーデータを複製せず、承認済みβ用fixtureだけを別手順で投入する。
- CORSはAPI GatewayとLambdaの二層でexact staging originを要求する。

## 実施していないこと

AWS接続、CloudFormation service validation、resource作成、artifact upload、secret操作、flag有効化、Bedrock呼び出し、deploy、push、PR作成は行っていません。

## ローカル検証結果

```text
CLOUDFORMATION_JSON_PARSE: PASS
READING_STAGING_IAC_LOCAL_VALIDATE: PASS
IAC_ADVERSARIAL_TESTS: 5 passed / 0 failed / 0 skipped
ALL_REGRESSION_TESTS_LOCAL_NODE: 172 passed / 0 failed / 0 skipped
ALL_REGRESSION_TESTS_NODE_22_23_1: 172 passed / 0 failed / 0 skipped
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
IAM_WILDCARD_RESOURCE_SCAN: PASS
FORBIDDEN_REFERENCE_SCAN: PASS
CFN_LINT: NOT_INSTALLED
AWS_SERVICE_VALIDATE: NOT_EXECUTED
AWS_CONNECTIONS: 0
AWS_RESOURCES_CREATED: 0
```

ローカルvalidatorはrequest roleへのBedrock追加、status roleへのwrite/SQS/Bedrock追加、IAM wildcard resource、Global profile、kill switch既定有効化を拒否する回帰を含みます。

AWS仕様の根拠:

- HTTP API path mapping: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html
- SQS event sourceとvisibility: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
- SQS maximum concurrency: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html
- Bedrock inference profile IAM: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
- Claude Haiku 4.5 JP Geo boundary: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
