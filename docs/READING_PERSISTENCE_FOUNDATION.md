# 鑑定API 冪等性・履歴永続化基盤

> 永続Rate Limitとlight/deep同時実行枠は[READING_RATE_LIMIT.md](./READING_RATE_LIMIT.md)のとおり、idempotency・history・deep月間quotaと原子的に統合します。短時間`used`は生成失敗で戻さず、concurrencyは完了・失敗で解放し、crash時はlease満了後に回収します。

## 既存履歴監査

既存Python履歴はDynamoDBの複合主キー`user_id`（partition key）＋`history_id`（sort key）を使用します。環境変数名は`TABLE_NAME`、`HISTORY_TABLE`、`HISTORY_TABLE_NAME`が混在し、旧saveはクライアント送信本文を広く保存します。新Node経路はキー構造だけを互換利用し、専用`READING_HISTORY_TABLE_NAME`と`shirone-reading-history-v1` itemを使います。既存Python Lambdaは変更していません。

## 環境変数

- `READING_IDEMPOTENCY_TABLE_NAME`
- `READING_HISTORY_TABLE_NAME`
- `READING_IDEMPOTENCY_HASH_SECRET`（session／audit secretと別鍵、32文字以上）
- `READING_IDEMPOTENCY_LEASE_SECONDS`（既定120、90～900の整数）
- `READING_IDEMPOTENCY_TTL_SECONDS`（既定604800、3600～2592000の整数）
- `READING_DEEP_GENERATE_API_ENABLED`（厳密な`true`のみ。権利消費の代替ではない）

空、小数、負数、指数表記、範囲外はfail closedです。実table名とsecretはリポジトリへ追加しません。

## request referenceとfingerprint

`request_ref`は専用secretによるHMAC-SHA256 hex 64文字で、domain separator、token由来user ID、検証済みIdempotency-Keyから生成します。fingerprintも別domainで、API contract versionと正規化済みname／birth date／question／requested modeを長さ付き固定順序でHMAC化します。生key、user ID、PIIはidempotency itemへ保存しません。比較は長さ・hex形式確認後にconstant-timeで行います。

secret rotationで過去request_refへ到達できなくなるため、複数世代照会または保持期間終了を待つ移行計画なしに鍵を交換しません。

## 状態と回収

`IN_PROGRESS`、`COMPLETED`、`FAILED`を使用します。新規は`attribute_not_exists(request_ref)`付きPutで予約し、server UUIDのowner tokenとhistory IDを確定します。有効lease中は409、fingerprint不一致は409です。FAILED、lease失効、アプリ上のTTL失効はfingerprintと旧状態／期限を条件にUpdateし、勝者1件だけがtakeoverします。DynamoDB TTL削除は即時ではないため、`expires_at`をアプリでも評価します。retention終了後は同じkeyが新規操作になり得ます。

## 履歴と原子確定

履歴は`user_id + history_id`、固定source`server_reading_api_v1`、status`completed`、resolved mode、reading date、server created/updated time、最終public resultを保存します。Bedrock rendered時は整形本文、fallback時はcanonical本文です。request ID、key、request_ref、fingerprint、owner、会員item、prompt、生output、AWS metadataは保存しません。JSON本文は300,000 UTF-8 bytes以下に制限し、履歴はidempotency TTLで削除しません。

完了は1回の`TransactWriteItems`で、(1) historyの不存在条件付きPut、(2) idempotencyのstate／fingerprint／owner／history ID一致条件付きCOMPLETED Updateを行います。成功前に200を返しません。失敗は固定503で、片側成功や未保存結果の200を許しません。

COMPLETED再送はstrongly consistent Getで履歴を読み、schema／status／所有キーを検証し、新しいrequest IDだけを付けて返します。欠損・破損時は503とし再生成しません。

## 障害とIAM

生成例外時はowner一致条件でFAILED化を試みます。強制終了で更新できない場合はlease失効takeoverが回復経路です。AWS error、cancellation reason、item、本文は応答・監査へ出しません。

将来のhandler roleには対象idempotency tableへのGetItem／PutItem／UpdateItem、対象history tableへのGetItem／PutItem、および両tableだけを対象にしたTransactWriteItemsが必要です。`dynamodb:*`と全resource wildcardは推奨しません。実IAM変更は未実施です。

deep月間権利の予約・消費は[READING_DEEP_MONTHLY_QUOTA.md](./READING_DEEP_MONTHLY_QUOTA.md)の専用quota itemで拡張しました。rate limit、table／TTL／IAM／Lambda／API Gateway作成、deploy、UI接続は未実装です。一般開放は禁止します。
