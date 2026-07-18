# deep月間利用権・原子予約基盤

## 商品仕様と権限

deepの月間上限は日本時間の暦月ごとに3回です。新規生成にはusers正本の`plan=premium`、`subscription_status=active`、`deep_enabled=true`と利用者によるdeep明示選択が必要です。`deep_enabled`はmaster gateであり、消費カウンターではありません。premiumの標準モードは引き続きlightです。

`READING_DEEP_GENERATE_API_ENABLED`はこの実装では有効化しません。未設定時はdeep生成へ到達しません。free／light、既存Python Lambda、UI、AWSリソースは変更していません。

## table境界と環境変数

専用quota tableのpartition keyは文字列`quota_ref`です。実table、TTL、GSI、IAM、Lambda環境変数は未作成です。

- `READING_DEEP_QUOTA_TABLE_NAME`
- `READING_DEEP_QUOTA_HASH_SECRET`：32～4096文字、改行・NUL禁止。他用途のsecretと共用しない
- `READING_DEEP_RESERVATION_SECONDS`：既定600、120～1800の10進整数
- `USERS_TABLE_NAME`：既存users table。partition keyは文字列`user_id`

deepを明示有効化するときだけ全設定を必須とし、不正値は`READING_DEEP_QUOTA_CONFIG_ERROR`でfail closedします。空、空白、小数、負数、0、指数表記、単位付き、範囲外は拒否します。

## JST periodとquota_ref

`period_key`は注入されたserver Clockから`Asia/Tokyo`の`YYYY-MM`として生成します。クライアント時刻やOSローカルtimezoneを使いません。開始月のquotaを完了時にも使用するため、月またぎでも消費先は変わりません。新月は別itemとなりreset jobを必要としません。

`quota_ref`は次のHMAC-SHA256 UTF-8 hex 64文字です。

```text
HMAC(secret, "shirone-deep-quota-v1\0" + user_id + "\0" + period_key)
```

raw user_id、Idempotency-Key、PII、本文、owner token、AWS metadataはquota itemへ保存しません。secret rotationでは過去itemへ到達不能になるため、保持期間と移行を決めずに交換しません。

## quota itemと予約

itemは`schema_version=shirone-deep-quota-v1`、`period_key`、固定`limit=3`、`used`、最大3件の`reservations`、楽観`version`、server UTCのcreated／updated時刻だけを持ちます。`remaining`は保存せず次から導出します。

```text
max(3 - used - active_reservations_count, 0)
```

予約はserver UUIDの`reservation_id`、HMAC済み`request_ref`、server UUIDの`history_id`、予約時刻、Unix秒の期限だけです。期限判定はアプリケーションが行い、DynamoDB TTLへ依存しません。

## transaction

新規deep開始は1回の`TransactWriteItems`で次を確定します。

1. users itemのpremium／active／deep_enabled BOOL true ConditionCheck
2. version条件付きquota Put（期限切れ予約を検証後に除去し、新予約を追加）
3. idempotency IN_PROGRESS PutまたはFAILED／lease失効の条件付きUpdate

成功完了はhistory Put、idempotency COMPLETED＋CONSUMED、quotaの予約除去＋`used`加算を同一transactionで行います。成功前に200を返しません。canonical fallbackが確定結果になった場合も1回消費します。

生成失敗はidempotency FAILED＋RELEASEDとquota予約除去を同一transactionで行い、`used`を増やしません。COMPLETED replayは現在の会員状態や月quotaを再確認せず保存済み履歴を返し、再予約・再生成・再消費しません。

quota version競合は月間上限と同数の最大4並行を分類できるよう最大4回だけ再読込します。同じIdempotency-Keyは追加予約を作りません。lease takeoverで有効なdeep予約が残る場合は予約を再利用し、期限切れなら対応idempotencyのstate／reservation IDを確認した同一transactionで回収します。欠損・schema不一致・片側状態などは自動修復せず固定503です。

## 固定エラー

- `READING_DEEP_NOT_ENTITLED`：403
- `READING_DEEP_MONTHLY_LIMIT_REACHED`：403
- `READING_DEEP_QUOTA_CONFIG_ERROR`：500
- `READING_DEEP_QUOTA_UNAVAILABLE`：503
- `READING_DEEP_RESERVATION_INCONSISTENT`：503

レスポンスにlimit内部値、used、reservation ID、request_ref、quota_ref、version、AWS error、cancellation reason、user_idを含めません。会員ページ向け残数APIは今回作りません。

## 最小IAM（将来設定）

対象users tableのGetItemとConditionCheckを含むTransactWriteItems、quota tableのGetItem／PutItem／UpdateItem／TransactWriteItems、既存idempotency／history tableの必要操作だけが候補です。`dynamodb:*`、全resource wildcard、実ARN固定は行っていません。
