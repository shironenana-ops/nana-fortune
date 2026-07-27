# 有料鑑定 staging IaC

状態: `IMPLEMENTED_NOT_DEPLOYED`

このディレクトリは、有料鑑定の非同期実行基盤を`ap-northeast-1`のstagingへ構築するためのAWS CloudFormation JSONです。物理resource名は指定せず、CloudFormationが新規に割り当てます。既存resourceを名前の推測で更新しません。

## ローカル検証

```powershell
npm run validate:reading-staging-iac
node --test tests/readingStagingIac.test.mjs
```

この検証はJSON構文、resource構成、timeout、route、IAM分離、kill switch既定値をローカルで検査します。`aws cloudformation validate-template`、change set、deployはAWS接続になるため本作業では実行しません。

## fail closed

次のparameterは既定値がすべて`false`です。

- `ReadingGenerateApiEnabled`
- `ReadingAsyncPaidEnabled`
- `ReadingStatusApiEnabled`
- `ReadingBedrockEnabled`
- `WorkerEventSourceMappingsEnabled`

stackを作成しただけでは受付、status取得、Bedrock描画は有効になりません。有効化はstaging resourceの実在確認、IAM review、secret投入、artifact hash確認、mock user準備、change set review後に人間が個別承認します。

## deploy前に必要な入力

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

## API path adapter

外部契約は`POST /reading`ですが、既存request handlerは`/reading/generate`を厳密検証します。HTTP API integrationの`overwrite:path`で固定内部pathへ変換し、sourceの認証・入力検証を変更しません。statusは`GET /reading/status`を変換せず渡します。

## packaging

IaCはZIPを生成・uploadしません。deploy前に既存buildを実行し、各`dist/.../index.mjs`をZIP rootの`index.mjs`として個別包装してください。objectのSHA-256とS3 VersionIdをchange set review記録へ残します。

## 未実施

- AWS接続、CloudFormation validate、change set、deploy
- artifact upload
- secretの取得・作成・更新
- staging tableへのデータ投入
- API／SQS／DynamoDB／Bedrockの実E2E
- production resource作成・参照
