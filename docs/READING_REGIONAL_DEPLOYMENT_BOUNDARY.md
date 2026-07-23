# 白音七 鑑定基盤の地域分離境界

更新日: 2026-07-23

状態: Phase A設計案（未配備）

## 原則

日本版は `ap-northeast-1` をsource region、`JAPAN`を処理境界とする。日本向け初期公開でGlobal inference profileを既定にしない。将来のUS/EU展開は日本環境への集約ではなく、地域単位で独立環境を複製する。

## 地域ごとに分離するもの

- AWS accountまたは明示的に隔離されたenvironment
- source region、Bedrock model / inference profile、IAM、KMS、Secrets
- DynamoDB（会員、履歴、冪等性、deep quota、Rate Limit）、Lambda、API Gateway
- audit log、monitoring、budget、allowed origins、domain
- 地域固有の通貨、locale、データ保持・削除手順

履歴、会員情報、監査ログ、秘密値、Rate Limit itemを地域間で暗黙共有しない。複製や移行は、目的・対象・法的根拠・暗号化・削除手順を人間が承認した別作業とする。

## 共通化できるもの

- application sourceとversioned IaC module
- schema version、API contract、safe error code
- migration procedure、test suite、security control
- release checklistとlifecycle review手順

共通化は同じコードを使うという意味であり、秘密値、物理table名、account ID、実データを共有する意味ではない。

## 地域設定manifest案

```yaml
market: JP
sourceRegion: ap-northeast-1
processingScope: JAPAN
lightModelId: <region-specific-id>
deepModelId: <region-specific-id>
rateLimitPolicy: <approved-policy-version>
allowedOrigins: <region-specific-origins>
currency: JPY
locale: ja-JP
```

manifestにsecret、物理table名、account IDを含めない。model/profile IDとRate Limit値も人間承認後に環境別設定へ反映する。

## 地域追加gate

新地域は、推論先リージョン、データ保存、secret分離、IAM、課金、利用規約、監視、復旧、削除請求、越境移転の有無を確認するまで開放しない。JP設定をコピーしてhostnameだけ変える運用は禁止する。
