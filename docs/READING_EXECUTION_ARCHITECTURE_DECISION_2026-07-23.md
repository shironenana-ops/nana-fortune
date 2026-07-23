# 鑑定API実行方式の設計判断（2026-07-23）

状態: `DESIGNED_NOT_IMPLEMENTED`

対象: 白音七の限定β向け `POST /reading/generate`

## 結論

```text
HTTP_API_TIMEOUT_BOUNDARY: VERIFIED
CURRENT_SYNC_DESIGN: INCOMPATIBLE
EXECUTION_ARCHITECTURE_RECOMMENDATION: ASYNC_PAID_MODES
LIGHT_EXECUTION_MODE: ASYNC
DEEP_EXECUTION_MODE: ASYNC
GLOBAL_PROFILE_USED: NO
AWS_CHANGES: NONE
LIMITED_PAID_BETA_GATE: BLOCKED_BY_IMPLEMENTATION_AND_STAGING
```

freeは現在どおりcanonical engineだけを同期実行します。Bedrockを使うlight／deepは、受付処理と生成処理を分離し、SQS Standard Queue経由で非同期実行する方式を第一候補とします。

この文書は設計判断です。API、Lambda、SQS、DynamoDB、IAM、環境変数を変更しておらず、値はproductionへ適用されていません。

## 根拠となる事実

### AWSの実行境界

- API Gateway HTTP APIのintegration timeoutは最大30秒で、増加できません。
- Lambda関数のtimeoutは最大900秒です。長い処理をLambdaへ移せても、同期HTTP応答の30秒上限は変わりません。
- AWS SDK for JavaScript v3の`abortSignal`は、クライアント側で未完了リクエストを中断するためのものです。API Gatewayの応答期限を延長せず、サーバー側で処理が絶対に継続しないことまで保証する境界として扱いません。
- SQSをLambda event sourceにするとat-least-once deliveryとなり、重複配信を前提に冪等化する必要があります。
- DynamoDB TTLは期限直後の削除を保証せず、通常は数日以内に非同期削除されます。TTLを権利判定やlease正しさの根拠にしません。

AWS公式資料:

- https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html
- https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html
- https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/introduction/
- https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html

### repositoryで確認した現在値

- `readingApiHandler.ts`は`POST /reading/generate`を受け、`readingApiService.ts`の完了後に200を返します。
- `readingApiService.ts`は認証、会員照会、入力検証、冪等性、Rate Limit、deep予約、同時実行枠、engine、Bedrock、history確定を1リクエスト内で順番に実行します。
- `bedrockReadingProseRenderer.ts`の既定timeoutは60,000ms、許容範囲は5,000～180,000msです。
- lightの`maxTokens`は5,000、deepは12,000です。
- 2026-07-17のlight実AWS smokeは約21.7秒でした。これは単一の成功例であり、HTTP全体のP95、cold start、DynamoDB処理、混雑、deepを保証しません。

したがって、現行の同期設計は「30秒以内を保証できる設計」と両立しません。特に設定可能なBedrock timeout自体がHTTP API上限を超えています。

## 選択肢比較

| 選択肢 | 30秒境界 | UX | 実装・運用 | 失敗復旧・整合性 | 判断 |
|---|---|---|---|---|---|
| A. free同期、light同期、deep非同期 | lightに余裕が少なく、P95未確認 | lightは即時、deepは待機 | paidで同期／非同期の2経路 | lightの切断後確定やtimeout競合が残る | 不採用 |
| B. free同期、light／deep非同期 | paid生成を30秒境界から分離 | 受付後に状態確認が必要 | paidを1つのjob protocolへ統一 | 重複、lease、再配信を同じ規則で制御可能 | **推奨** |
| C. free／light／deep同期 | 現在値と両立しない | 即時表示を狙える | 一見単純 | 30秒後の裏走り、履歴・quotaの不確実性 | 不採用 |
| D. Lambda非同期invoke | 30秒境界から分離 | Bと同等 | 明示queueを減らせる | 内部queueの可視性・再処理制御がSQSより弱い | 初版不採用 |

## 推奨フロー

```text
Browser
  -> API Gateway HTTP API
    -> request Lambda
      -> authentication / membership / validation
      -> idempotency precheck
      -> SendMessage(opaque job_ref only)
      -> DynamoDB transaction
           job + processing history + idempotency + rate count
           + deep reservation when applicable
      <- 202 Accepted

SQS light/deep queue
  -> light/deep worker Lambda
      -> conditional job claim + per-user concurrency lease
      -> canonical engine
      -> Bedrock JP Geo profile
      -> transaction: COMPLETED history/result/idempotency/quota/release
      or transaction: FAILED history/idempotency/quota release/concurrency release

Browser
  -> existing history detail route, hardened for status polling
```

queueへはraw user ID、氏名、生年月日、質問、token、鑑定本文を入れません。messageは推測困難な`job_ref`とschema versionだけにします。入力は暗号化されたjob itemへ置き、request workerだけが読み取れるようにします。

## 受付と原子性

SQSとDynamoDBを1つのACID transactionにはできません。初期stagingでは次のqueue-first protocolを提案します。

1. token由来user IDで認証し、mode、会員権限、入力、Idempotency-Keyを検証する。
2. idempotencyをstrongly consistent readし、replay、409 conflict、処理中を判定する。
3. opaque `job_ref`だけを対応するqueueへ送る。
4. 送信成功後、DynamoDB transactionでjob、processing history、idempotency、Rate Limit、deep予約を条件付き作成する。
5. transaction成功後だけ202を返す。

queue送信失敗時はDynamoDBを変更しないため、Rate Limitやdeep枠を消費しません。transaction競合時にqueue messageだけ残る可能性があります。workerがjobをまだ見つけられない場合、messageの送信時刻から60秒まではretryし、それ以降はBedrockを呼ばずackして`reading_orphan_message_discarded`を記録します。本文や識別子は記録しません。

transactional outboxはこの隙間をさらに狭めますが、DynamoDB Streamsとdispatcherを追加します。初期stagingでは採用せず、orphan metricや再配信結果でqueue-firstの妥当性を評価します。

## 状態と所有権

内部job stateは次の4つに限定します。

```text
QUEUED -> IN_PROGRESS -> COMPLETED
                     -> FAILED
```

- `QUEUED`: 受付transaction完了。Rate Limitは計上済み。deep枠は予約済み。同時実行枠は未占有。
- `IN_PROGRESS`: workerが条件付きclaimし、同時実行leaseを取得済み。
- `COMPLETED`: 同じhistory itemを完成結果で更新し、idempotencyを確定し、deep予約を消費し、同時実行枠を解放済み。
- `FAILED`: 安全な失敗分類でhistoryを更新し、idempotencyを失敗確定し、deep予約と同時実行枠を解放済み。

状態遷移はjobの`version`、owner token、lease expiry、現在stateをConditionExpressionで検査します。TTL削除やqueue受信回数だけでは遷移を許可しません。

status/detail取得はtoken由来user IDで所有権を確認し、bodyやqueryのuser IDを信用しません。job IDだけで他人の状態を読めないようにします。raw user ID、内部DynamoDB属性名、owner tokenは公開しません。

## 冪等性・再配信

- 同じIdempotency-Key・同じcanonical input hashは同じjobまたは完成結果を返します。
- 同じkey・異なるinputは409です。
- `QUEUED`／`IN_PROGRESS`の再送で新しいworkerや権利消費を増やしません。
- `COMPLETED`の再送でBedrockを再実行しません。
- `FAILED`後の利用者による明示retryは新attemptとし、新しいIdempotency-Key、Rate Limit、必要なdeep予約を要求します。
- SQS duplicate deliveryでは、`COMPLETED`／`FAILED`を確認してBedrockを呼ばずackします。
- active lease中の重複は処理を奪いません。期限切れleaseだけ条件付きtakeoverを許可します。

## Rate Limit・quota・concurrency

- Rate Limitは新規jobの受付transactionで1回だけ計上します。duplicate deliveryでは計上しません。
- deep月間枠は受付transactionで予約し、成功transactionで消費、terminal failureで解放します。
- queue待機中はuser concurrencyを占有しません。worker開始時にlight／deepそれぞれ既存方針の1枠を取得します。
- transient failureでSQS再配信する場合はconcurrencyを解放し、jobを`QUEUED`へ戻します。Rate Limitとdeep予約は維持します。
- poison message、validator failure、configuration errorなど再実行で直らない失敗は`FAILED`にし、deep予約とconcurrencyを解放してackします。
- DLQへ移ったjobは自動で権利を確定しません。運用者が安全な失敗確定またはre-driveを選びます。手動処理は監査記録を必須にします。

## history方針

- 202確定時に、既存historyの利用者向け状態と互換な`processing` itemを作ります。
- workerは同じhistory itemを`completed`または`error`へ更新します。
- idempotency TTLとhistory保持期間を混同しません。idempotency itemが削除されても、完成したhistory本文は保持方針に従います。
- 完成後に会員ランクが下がっても、本人は過去の完成結果を閲覧できます。新規deep生成権とは分離します。
- 現在のPython history detail実装をそのまま非同期status APIの根拠にはしません。次PRでCORS、公開DTO、raw user ID非表示、token所有権を再確認します。

## 次の実装PR境界

1. async contractとjob state machineの型／validator／unit test。
2. job persistenceとqueue-first受付transaction。AWS接続なしのadapter test。
3. light／deep worker、duplicate delivery、lease takeover、partial batch failure test。
4. status/history detailの安全な公開DTOとUI polling。
5. IaC、staging IAM、queue、table、alarms。人間レビュー後に限定staging deploy。

この順番を飛ばして既存同期handlerをAWSへ配備しません。
