# 有料鑑定 staging IaC

状態: `DEPLOYED_FAIL_CLOSED_ROUTE_KEY_FIX_PENDING_REDEPLOY`

このディレクトリは、有料鑑定の非同期実行基盤を`ap-northeast-1`のstagingへ構築するためのAWS CloudFormation JSONです。物理resource名は指定せず、CloudFormationが新規に割り当てます。既存resourceを名前の推測で更新しません。

## ローカル検証

```powershell
npm run validate:reading-staging-iac
node --test tests/readingStagingIac.test.mjs
```

この検証はJSON構文、resource構成、timeout、route、IAM分離、kill switch既定値をローカルで検査します。stagingでは2026-07-27に`aws cloudformation validate-template`、change set review、初回deployまで実施して`CREATE_COMPLETE`を確認し、その後の公開path統一版も`UPDATE_COMPLETE`を確認しています。

## fail closed

次のparameterは既定値がすべて`false`です。

- `ReadingGenerateApiEnabled`
- `ReadingAsyncPaidEnabled`
- `ReadingStatusApiEnabled`
- `ReadingBedrockEnabled`
- `WorkerEventSourceMappingsEnabled`

stackを作成しただけでは受付、status取得、Bedrock描画は有効になりません。有効化はstaging resourceの実在確認、IAM review、secret投入、artifact hash確認、mock user準備、change set review後に人間が個別承認します。

## staging deploy入力

- 4つのLambda ZIPを置くstaging専用S3 bucketとobject key
- stagingの完全一致origin
- 4種類の秘密値を含む既存Secrets Manager secretのARN
  - `session_token_secret`
  - `audit_hash_secret`
  - `reading_idempotency_hash_secret`
  - `reading_deep_quota_hash_secret`
- light/deepそれぞれのJP Geo inference profile ID、alias、exact profile ARN
- profileがroutingする東京・大阪のexact foundation model ARN
- resource tagging用のOwner、CostCenter

CloudFormation stack名は、生成されるLambda名が64文字以内に収まるよう40文字以下とし、既存stack／functionと重複しない新規staging名を人間が確認します。名前が衝突した場合は別resourceへ置換せず、change set作成前に停止します。

秘密値、account ID、実origin、artifact bucket名をrepositoryへ保存しません。

## Bedrock IAM

各workerは対応するprofile ARNと、そのprofileがroutingする東京・大阪のfoundation model ARNだけへ`bedrock:InvokeModel`できます。foundation model側には`bedrock:InferenceProfileArn`条件を付けます。Global inference profile、反対modeのprofile、`Resource: "*"`は許可しません。

## API path contract

公開endpointはrequestが`POST /reading`、statusが`GET /reading/status`です。両handlerともAPI Gateway HTTP API payload v2.0の`routeKey`を正規route識別に使い、named stageを含み得る`rawPath`には依存しません。HTTP API integrationでは`overwrite:path`を使用しません。

2026-07-27のstaging実機試験で、named stageではLambda eventの`rawPath`が`/staging/reading`となり、`/reading`との厳密比較で`HTTP_ROUTE_NOT_FOUND`になることを確認しました。Lambda直接invokeでは`rawPath=/reading`がkill switchの安全な503へ到達し、`rawPath=/staging/reading`で同じ404を再現しています。`routeKey`を正とするsource修正はローカル検証対象であり、修正版request artifactのAWS再deployと実E2Eは未実施です。

## packaging

IaCはZIPを生成・uploadしません。deploy前に既存buildを実行し、各`dist/.../index.mjs`をZIP rootの`index.mjs`として個別包装してください。objectのSHA-256とS3 VersionIdをchange set review記録へ残します。

## 未実施

- `/reading` path修正版request artifactのbuild・upload・staging再deploy
- staging tableへのテストデータ投入
- API／SQS／DynamoDB／Bedrockの実E2E
- kill switchの段階的有効化
- production resource作成・参照
