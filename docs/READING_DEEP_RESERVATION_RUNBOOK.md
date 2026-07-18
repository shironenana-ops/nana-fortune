# deep予約・障害復旧runbook（設計）

## 通常確認

公開レスポンスや通常監査ログへ内部IDを出しません。運用調査はアクセス制限された環境で、対象期間とHMAC参照を人間が別途安全に特定して行います。PII、token、prompt、本文、AWS request ID、生SDK errorをチケットやチャットへ貼り付けません。

確認対象はidempotency state、history存在、quotaのused／reservation存在、deep reservation stateです。

- COMPLETED＋historyあり＋予約なし＋CONSUMED：完了。枠を戻さずreplayする
- IN_PROGRESS＋historyなし＋予約あり：処理継続またはlease takeoverへ委ねる
- FAILED＋historyなし＋予約なし＋RELEASED：安全な再試行候補
- historyだけ、COMPLETEDだけ、usedだけ増加、予約だけ消失、ID不一致、schema不一致：自動修復禁止

## 期限切れ

通常request時に同じquota item内の最大3予約だけを確認します。期限切れ予約は対応idempotencyがIN_PROGRESS、deep state RESERVED、reservation ID一致、未完了である場合だけ、同一transactionで予約除去とFAILED／RELEASED_EXPIRED化を行います。idempotency欠損・COMPLETED・ID不一致は503で停止します。Scan、scheduler、Stream、EventBridgeは使用しません。

## transaction結果不明

SDK timeoutや通信断では即時解放・再生成しません。strongly consistent Getでidempotency、history、quotaを再確認します。完了が確認できれば保存済み履歴を返します。予約継続なら安全な503／処理中とし、leaseへ委ねます。矛盾時は自動修復や無条件の枠返却をせず、二人確認の条件付き運用作業として扱います。

transactionにはphase別でPIIを含まない36文字のClientRequestTokenを使用します。楽観version再試行でtransaction入力が変わる場合はtokenもversionで分離します。DynamoDBのtoken有効期間内に異なる入力を同じtokenで送信しません。

## 手動復旧条件

実AWS操作は今回未実施です。将来の手動修復では、対象table・key・期待version・期待state・reservation ID・影響・復元可能性を提示し、別途明示承認を得てから条件付きtransactionを実行します。無条件Update、table Scanからの一括修復、TTL待ちを利用可否判定に使うことは禁止します。

## 未実装

table／TTL／IAM／Lambda／API Gateway設定、deploy、rate limit、残数API／UI、CloudWatch alarm、一般開放、MOSH／fincode連携、単発deep、翌月繰越は未実装です。`READING_DEEP_GENERATE_API_ENABLED`は未設定のままです。
