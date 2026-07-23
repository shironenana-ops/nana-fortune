# 鑑定API staging基盤設計

状態: `DESIGNED_NOT_PROVISIONED`

region: `ap-northeast-1`

processing scope: `JAPAN`

Global inference profile: 使用しない

この文書に実resource名、AWS account ID、secret値、production値は含めません。AWS resource、IAM、環境変数、flagは作成・変更していません。

## 構成

```text
staging web origin
  -> API Gateway HTTP API / staging stage
    -> request Lambda
      -> DynamoDB state tables
      -> light SQS Standard Queue
      -> deep SQS Standard Queue

light queue -> light worker Lambda -> Haiku 4.5 JP Geo inference profile
deep queue  -> deep worker Lambda  -> Sonnet 4.5 JP Geo inference profile

light/deep queue -> corresponding DLQ
all components -> CloudWatch Logs / Metrics / Alarms
AWS Budgets -> human notification
```

light／deepを別queue・worker・roleに分け、model permission、timeout、DLQ、alarm、costを独立させます。request LambdaにはBedrock権限を付けません。

## API Gatewayとrequest Lambda

| 項目 | staging候補 | 理由 |
|---|---:|---|
| API type | HTTP API payload v2.0 | 現行handler前提を維持 |
| stage | 明示的staging stage | productionとの混同防止 |
| integration timeout | 30秒以下（AWS固定上限） | 上限を延長できない |
| request internal deadline | 10秒 | queue＋transaction＋cleanupを15秒Lambda内で終える |
| request Lambda timeout | 15秒 | internal deadline後の後処理buffer 5秒 |
| reserved concurrency | 5 | 限定βの入口を抑え、workerと分離 |
| CORS | staging origin完全一致 | wildcard禁止 |

request Lambdaの責務は認証、会員照会、入力検証、冪等性precheck、queue送信、受付transaction、202応答だけです。engineとBedrockを実行しません。

## SQSとworker

| 項目 | light候補 | deep候補 |
|---|---:|---:|
| queue type | Standard | Standard |
| batch size | 1 | 1 |
| worker Lambda timeout | 120秒 | 240秒 |
| Bedrock timeout | 90秒 | 180秒 |
| persistence/cleanup buffer | 30秒 | 60秒 |
| visibility timeout | 720秒 | 1,440秒 |
| concurrency lease | 180秒 | 360秒 |
| maxReceiveCount | 5 | 5 |
| source retention | 1日 | 1日 |
| DLQ retention | 14日 | 14日 |
| event source maximum concurrency | 5 | 5 |
| worker reserved concurrency | 5 | 5 |
| SDK maxAttempts | 1 | 1 |

visibility timeoutはAWS推奨どおりworker Lambda timeoutの6倍です。DLQ retentionはsource queueより長くします。batch size 1によりpartial batch failureの境界を単一jobへ限定しますが、`ReportBatchItemFailures`を有効にし、将来batch sizeを変えても成功messageを再試行しない契約を維持します。

自動retryはSQS receiveに限定し、Bedrock SDKの内部再試行は増やしません。poison messageは5回でDLQへ送ります。re-driveは人間承認、対象件数、job state、quota reservation、重複実行防止を確認してから行います。

AWS公式資料:

- https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/setting-up-dead-letter-queue-retention.html

## DynamoDB

stagingではproduction tableを参照せず、環境別に分離したtableを使います。

| 論理table | 再利用／新規 | 主なkey | TTL | PITR | deletion protection |
|---|---|---|---|---|---|
| users | 既存論理構造のstaging版 | token由来user key | なし | 有効 | 有効 |
| history | 既存論理構造のstaging版 | owner + reading ID | なし | 有効 | 有効 |
| idempotency | 既存論理構造のstaging版 | HMAC request ref | cleanup用 | 有効 | 有効 |
| rate/concurrency | 既存論理構造のstaging版 | HMAC scope ref | cleanup用 | 有効 | 有効 |
| deep quota | 既存論理構造のstaging版 | HMAC user + JST period | cleanup用 | 有効 | 有効 |
| reading jobs | **新規** | opaque job ref | cleanup用 | 無効候補 | 有効 |

job itemの候補属性:

```text
schema_version
job_ref
history_id
mode
state
version
canonical_input (encrypted at rest, worker only)
owner_user_id (token由来。暗号化table内だけ、request/status/workerに限定)
owner_ref (監査用HMAC; raw user IDではない)
created_at / updated_at
lease_owner / lease_expires_at
attempt_count
safe_failure_category
expires_at (cleanup hint only)
```

queueに入力やraw user IDを載せないため、job tableが必要です。workerがhistoryを本人所有keyで更新するためのtoken由来user IDは、暗号化されたjob item内だけに保持し、queue、log、公開DTOへ出しません。history、idempotency、rate、quotaだけへjob入力を混在させません。

- billing modeは`PAY_PER_REQUEST`候補です。限定βの変動負荷でcapacity planningを不要にします。
- DynamoDB server-side encryptionを必須とします。AWS owned keyかcustomer managed KMS keyかは人間のセキュリティ／費用判断まで未確定です。
- PITRはstateful source-of-truth tableで有効化候補です。短期job tableはhistoryとqueueから復旧方針を検証してから判断します。
- TTLは容量整理だけに使います。itemの`expires_at`をアプリケーション条件で評価し、TTL削除時刻を権利解放やlease takeoverの根拠にしません。
- backup復元は新tableを作るため、復元後の名前、IAM、event source、検証手順をrunbook化してから限定βを開きます。

AWS公式資料:

- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Backup-and-Restore.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithTables.Basics.html

## IAM境界

resource ARNはIaC作成時にstaging専用の完全ARNへ置換し、runtime roleへ`*`や`AmazonBedrockFullAccess`を付けません。

### request Lambda role

- users: `GetItem`
- idempotency: `GetItem`
- jobs/history/idempotency/rate/quota: 必要な`PutItem`、`UpdateItem`、`TransactWriteItems`
- light/deep queue: `SendMessage`
- CloudWatch Logs: 自身のlog groupへの最小権限
- **Bedrock権限なし**
- **queue受信／削除権限なし**

### light worker role

- light queueだけ: `ReceiveMessage`、`DeleteMessage`、`ChangeMessageVisibility`、`GetQueueAttributes`
- jobs/history/idempotency/rate-concurrency: 必要なread／conditional update／transaction
- light JP Geo profile: `bedrock:InvokeModel`
- profile内の東京／大阪destination foundation model: `bedrock:InvokeModel`
- `bedrock:InferenceProfileArn`をlight profile ARNへ限定するCondition
- deep queue、deep profile、users table、production resourceへの権限なし

### deep worker role

- deep queueだけの受信権限
- jobs/history/idempotency/rate-concurrency/deep quotaの必要最小権限
- deep JP Geo profileとその東京／大阪destination foundation modelへの`bedrock:InvokeModel`
- `bedrock:InferenceProfileArn`をdeep profile ARNへ限定するCondition
- light queue、light profile、production resourceへの権限なし

JP Geo profileではprofile ARNだけでなく、profileがroutingし得る各destination regionのfoundation model ARNも許可する必要があります。Global profile ARNとGlobal destinationはpolicyに含めません。exact ARNはAWS公式model cardと対象accountのstaging profile確認後に人間レビューします。

候補profile ID:

- light: `jp.anthropic.claude-haiku-4-5-20251001-v1:0`
- deep: `jp.anthropic.claude-sonnet-4-5-20250929-v1:0`

AWS公式資料:

- https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html

## 秘密情報と設定

- secret値はSecrets Managerまたは承認済みの暗号化環境設定からruntimeに渡します。
- source、IaC variable default、log、metric dimension、queue messageへsecretを入れません。
- 必須secret／設定が空、形式不正、範囲外ならfail closedです。
- `READING_GENERATE_API_ENABLED`、`READING_DEEP_GENERATE_API_ENABLED`、`READING_BEDROCK_ENABLED`はこの設計で設定しません。
- model IDは環境変数のままとし、production sourceへ固定しません。

## Logs・metrics・alarms

staging log retention候補は30日です。prompt、入力、鑑定本文、生AWS error、AWS request ID、token、raw user ID、Idempotency-Key、queue receipt handleを記録しません。

最低限のmetric／alarm候補:

| 分類 | metric | warning候補 | critical候補 |
|---|---|---:|---:|
| API | 202／409／429／5xx | baseline逸脱 | 5xx連続 |
| queue | ApproximateAgeOfOldestMessage | light 120秒、deep 300秒 | visibility timeoutの50% |
| queue | DLQ visible messages | 1 | 1が継続 |
| worker | errors／timeouts／throttles | 1 | 連続または比率超過 |
| Bedrock | Invocations／InvocationLatency | P95候補超過 | timeout接近 |
| Bedrock | InvocationClientErrors／ServerErrors／Throttles | 1 | 継続 |
| Bedrock | InputTokenCount／OutputTokenCount | 想定P95超過 | configured max接近 |
| application | fallback／orphan／lease reclaim | 1 | 継続増加 |
| control | deep quota denial／Rate Limit denial | 観測 | 急増 |
| DynamoDB | throttle／transaction conflict | 1 | 継続 |

alarm thresholdは未承認候補です。staging実測P50／P95、利用人数、正常retryを観測して確定します。

Bedrock runtime metric公式資料:

- https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-runtime-metrics.html

## Budget候補

Phase Aのconfigured max試算（USD/JPY=160）を使い、1 tester／月あたりlight 30回、deep 3回を仮定します。

```text
light: 7.92円 x 30 = 237.60円
deep: 58.08円 x 3 = 174.24円
Bedrock subtotal = 411.84円 / tester / month
```

API Gateway、Lambda、SQS、DynamoDB、Logs、再試行の余白を約40%見込み、丸めたstaging monthly budget候補は次です。

| 限定tester | 計算上の余白込み目安 | budget候補 |
|---:|---:|---:|
| 1人 | 約577円 | 1,000円 |
| 5人 | 約2,883円 | 3,000円 |
| 10人 | 約5,766円 | 6,000円 |

通知候補:

- warning: 50%
- major: 80%
- critical: 100%
- 宛先: 承認済み運用者email／SNS topicのplaceholder

AWS Budgetsは請求情報更新後に通知するため遅延し得ます。Budget通知だけでAPIを自動停止したとはみなしません。実時間の防御はfeature flag、Rate Limit、deep quota、reserved concurrencyです。critical通知後のflag停止は人間承認runbookにします。

AWS公式資料:

- https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html

## Tagging

全resourceへ少なくとも次のtagを要求します。値はIaCレビューで確定します。

```text
Project
Environment=staging
Component
DataClassification
Owner
CostCenter
ManagedBy
```

## staging gate

以下が揃うまで限定有料βを開きません。

- async protocolとfailure matrixの実装／unit test
- IaC差分とleast-privilege IAMの人間レビュー
- staging専用resource作成の個別承認
- mode別JP Geo profileのHTTP 200 smokeとGlobal未使用証跡
- duplicate delivery、lease expiry、orphan、DLQ、re-driveの安全試験
- token／latency／fallback／queue age／quota／Rate Limitの観測
- budget額、通知先、停止手順の人間承認
- flags未設定状態から段階的に有効化するrunbook

```text
STAGING_INFRASTRUCTURE: DESIGNED
IAM_BOUNDARY: DESIGNED
TIMEOUT_POLICY: PROPOSED
CONCURRENCY_LEASE_POLICY: PROPOSED
AWS_CHANGES: NONE
LIMITED_PAID_BETA_GATE: BLOCKED_BY_IMPLEMENTATION_AND_STAGING
```
