# 鑑定APIのRate Limitと同時実行制御

## 目的と境界

`POST /reading/generate` は、認証済み利用者、サーバーで確認した会員プラン、サーバーで解決した鑑定モードを単位として、永続的な短時間Rate Limitを適用します。lightとdeepは、同一利用者・同一モードにつき同時実行1件に制限します。

これはdeepの日本時間暦月3回という商品利用権、Idempotency-Keyによる同一論理リクエストの重複防止とは別の制御です。MOSH連携や権限付与は行いません。

## 安全方針

- LambdaローカルメモリやIPアドレスには依存しない
- DynamoDBの条件付き更新を、idempotency・deep月間予約と同じトランザクションへ入れる
- bodyの`requested_mode`ではなく、サーバー解決済み`resolvedMode`を使う
- bodyのuser IDではなく、認証済みsessionのuser IDを使う
- raw user ID、メール、氏名、質問、session token、Idempotency-Key生値をRate Limit tableへ保存しない
- HMAC-SHA256 refは既存secretをdomain separationして生成する
- Rate Limit取得後に生成が失敗しても、短時間カウンタは戻さない
- light/deepの同時実行枠は完了・失敗時に原子的に解放し、異常終了時はlease満了後にlazy reclaimする

## Policy scopeと環境変数

許可される組合せは`free/free`、`light/free`、`light/light`、`premium/free`、`premium/light`、`premium/deep`の6個だけです。

具体的な回数と時間窓は、2026-07-23に限定β向け候補として人間承認されました。承認値は`READING_RATE_LIMIT_POLICY_APPROVED_2026-07-23.json`へ固定していますが、まだproductionへ適用していません。コードにproduction defaultはなく、artifactもruntimeで自動読込しません。APIを有効化する場合、次の値を環境ごとにすべて明示し、不足・空・小数・負数・0・範囲外・unsafe integerは`READING_RATE_LIMIT_NOT_CONFIGURED`でfail closedします。

```text
READING_RATE_LIMIT_TABLE_NAME
READING_RATE_LIMIT_FREE_FREE_MAX
READING_RATE_LIMIT_FREE_FREE_WINDOW_SECONDS
READING_RATE_LIMIT_LIGHT_FREE_MAX
READING_RATE_LIMIT_LIGHT_FREE_WINDOW_SECONDS
READING_RATE_LIMIT_LIGHT_LIGHT_MAX
READING_RATE_LIMIT_LIGHT_LIGHT_WINDOW_SECONDS
READING_RATE_LIMIT_PREMIUM_FREE_MAX
READING_RATE_LIMIT_PREMIUM_FREE_WINDOW_SECONDS
READING_RATE_LIMIT_PREMIUM_LIGHT_MAX
READING_RATE_LIMIT_PREMIUM_LIGHT_WINDOW_SECONDS
READING_RATE_LIMIT_PREMIUM_DEEP_MAX
READING_RATE_LIMIT_PREMIUM_DEEP_WINDOW_SECONDS
READING_CONCURRENCY_LIGHT_LIMIT
READING_CONCURRENCY_DEEP_LIMIT
READING_CONCURRENCY_LEASE_SECONDS
```

light/deep concurrencyは1以外を拒否します。承認済みの限定β候補は、free/free 10回/600秒、light/free 10回/600秒、light/light 3回/900秒、premium/free 10回/600秒、premium/light 5回/900秒、premium/deep 2回/1800秒、concurrency light/deep各1です。staging再検証と適用承認なしにproduction値へ転用してはいけません。

## DynamoDB model

partition keyは`rate_limit_ref`です。固定窓itemは`shirone-reading-rate-window-v1`、同時実行itemは`shirone-reading-concurrency-v1`です。TTLは古いitemの整理だけに使い、正しさはwindow epoch、version、lease expiry、条件式で判断します。

```text
HMAC(secret, "reading-rate-window-v1\0" + userId + "\0" + tier + "\0" + mode + "\0" + windowStart)
HMAC(secret, "reading-concurrency-v1\0" + userId + "\0" + mode)
```

## Idempotencyとカウント

completed replay、conflict、in-progress、認証・会員照会・入力検証・権限・mode・kill switch・CORS・route・method・Content-Type・body sizeの拒否は数えません。

新規acquire、FAILEDからの再試行、lease満了takeoverは新しいgeneration attemptとして数えます。同じrequestRefでも実際に再生成する試行は短時間カウンタを消費します。completed replayはRate Limitも同時実行枠も消費しません。

## Atomicityと復旧

non-deepの開始は、Rate window、light concurrency、idempotency Putまたはtakeover Updateを同一transactionで確定します。deepはさらにmembership ConditionCheck、JST月間quota予約、期限切れ予約整理を同じtransactionへ含めます。

同時実行枠が占有中ならRate Limitは増えません。Rate Limit超過ならidempotency、concurrency、deep予約は残りません。deep月間枠超過ならRate Limitは増えません。完了時はhistory、idempotency、deep消費、concurrency解放を同一transactionへ含め、失敗時はFAILED、deep予約解放、concurrency解放を同一transactionへ含めます。

## HTTPと監査

短時間超過と同時実行超過は429です。安全に算出できる場合のみ、正の整数秒の`Retry-After`を返します。内部limit、HMAC ref、table名、AWS error、AWS request IDは公開しません。

監査eventは`reading_rate_limited`、`reading_concurrency_limited`、`reading_rate_limit_unavailable`、`reading_concurrency_expired_reclaimed`です。raw user ID、PII、token、質問、Idempotency-Key、requestRef、rate_limit_ref、owner token、DynamoDB cancellation detailを記録しません。

## 現在のgate

```text
RATE_LIMIT_FOUNDATION: VERIFIED
RATE_LIMIT_POLICY_VALUES: APPROVED_FOR_LIMITED_BETA
RATE_LIMIT_POLICY_EFFECTIVE: NO
LIMITED_PAID_BETA_GATE: BLOCKED_BY_INFRA_AND_STAGING
```

承認済み値のstaging反映、DynamoDB/IAM/Lambda設定、監視、実測、限定公開承認が完了するまで一般開放しません。`READING_GENERATE_API_ENABLED`、`READING_DEEP_GENERATE_API_ENABLED`、`READING_BEDROCK_ENABLED`は、この実装作業では設定しません。
