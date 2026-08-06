# Release B production権限ブートストラップ

## 目的と境界

このディレクトリは、既存のRelease B実装を本番へ適用する前に、操作主体とCloudFormation実行主体を分離するためのブートストラップ一式です。アプリケーションの再設計、migration判断の再実施、Release Bのapplyは行いません。

- 操作者: IAM Identity Center Permission Set `NanaProductionReleaseBOperator`
- ローカルprofile: `nana-production-release-b`
- CloudFormation実行role: `NanaProductionCanonicalRuntimeExecutionRole`
- 本番account: `388811589005`
- region: `ap-northeast-1`
- Release B stack: `nana-reading-production`
- artifact bucket: `nana-prod-artifacts-388811589005-apne1`
- artifact prefix: `nana-reading-production/release-b/`
- 長期Access Key: 作成禁止

専用artifact bucketは作成済みです。所有account `388811589005`と東京regionをread-onlyで確認済みであり、policyとtemplateは上記bucketのexact ARNおよびprefixへ固定しています。

## 龍起が管理画面で行う5段階

### 1. 管理経路へ入り、本番境界とartifact bucketを確定する

既存のIAM Identity Center管理経路へログインします。AWS管理画面でaccount IDが `388811589005`、regionが東京であることを確認します。S3の `nana-prod-artifacts-388811589005-apne1` が同じaccountと東京regionにあり、prefixが `nana-reading-production/release-b/` であることを確認します。

### 2. Identity Center Permission Setを仮作成する

IAM Identity Center管理画面でPermission Set `NanaProductionReleaseBOperator` を作り、session durationを4時間にします。この時点では本番accountへassignmentせず、execution role作成後の完全なinline policyを入れるまで利用開始しません。

### 3. CloudFormation execution roleだけを作る

CloudFormation管理画面で [execution-role-bootstrap.yaml](./execution-role-bootstrap.yaml) を使い、stack `nana-production-release-b-bootstrap` を作成します。parameterは `ExpectedAccountId=388811589005`だけです。bucketとprefixはtemplate内でexact値へ固定されています。Change Setで作成対象がIAM Role 1件だけ、削除・置換・application resourceが0件であることを確認してから実行します。

### 4. Permission Setをexact policyで確定・割り当てする

[operator-permission-set-policy.json](./operator-permission-set-policy.json) はartifact bucketとprefixのexact ARNへ固定済みです。Runtime Secretがまだ存在しない間は `RuntimeSecretExactArnAfterCreation` statementを除外します。inline policyを設定し、対象ユーザーまたはgroupへ本番accountだけを割り当て、Permission Setをprovisionします。管理権限を持つ既存profileから [identity-center-bootstrap.ps1](./identity-center-bootstrap.ps1) を使う方法も同等です。既存Permission SetにAWS managed policy、customer managed policy、予期しないpermissions boundaryがある場合、scriptは停止します。

### 5. ローカルprofileを設定し、read-only smokeを通す

既存SSO session `shirone`を再利用し、[configure-release-profile.ps1](./configure-release-profile.ps1) を実行します。生成されるprofileは `nana-production-release-b` です。Access KeyやSecret Access Keyは作成しません。続けて次を実行し、profile、execution roleのCloudFormation専用trust、artifact bucketの東京region、legacy Users/Historyのread権限を確認します。smokeはAWS resourceを変更しません。

```powershell
Set-Location C:\work\nana-fortune
powershell -ExecutionPolicy Bypass -File .\ops\aws\production-release-b-bootstrap\post-bootstrap-smoke.ps1 `
  -Profile nana-production-release-b
```

両方の最終行がtrueになるまでRelease Bへ進みません。

- `production_release_b_operator_profile_ready`
- `production_cloudformation_execution_role_ready`

## ローカル検証

bucket名とprefixはexact値へ固定済みです。次の検証はplaceholder残存も拒否します。

```powershell
powershell -ExecutionPolicy Bypass -File .\ops\aws\production-release-b-bootstrap\validate-bootstrap.ps1
```

既存read-only profileでaccount境界とAWSのtemplate validationを追加する場合だけ `-AwsProfile` を指定します。

```powershell
powershell -ExecutionPolicy Bypass -File .\ops\aws\production-release-b-bootstrap\validate-bootstrap.ps1 `
  -AwsProfile nana-legacy-readonly
```

## 権限分離

Operatorは、Release B stackのChange Set操作、既存migration sourceのread、条件付きmigration transaction、限定prefixへのartifact upload、read-only検証だけを行います。`iam:PassRole`は次の1件だけです。

- resource: `NanaProductionCanonicalRuntimeExecutionRole`
- passed service: `cloudformation.amazonaws.com`

Execution roleは、`nana-reading-production-*`に限定したLambda、IAM runtime role、DynamoDB、SQS、Logs、Alarmと、Release B用HTTP API、production Runtime Secretだけを管理します。Identity Center、IAM user、Access Key、Organizations、fincode、決済provider権限は持ちません。

`Resource: "*"`は、resource-level ARNをサポートしない境界に限定しています。

- Operator: `sts:GetCallerIdentity`、東京region限定の`cloudformation:ValidateTemplate`と`lambda:ListEventSourceMappings`
- Execution role: 東京region限定のLambda EventSourceMapping管理

## Release Bの再開地点

profileとexecution roleのread-only smokeがPASSしたら、既存Release Bを次の地点から再開します。既存実装、migration dry-run、5件の判断manifestは作り直しません。

1. production Runtime Secret用の独立Change Setを作成する
2. Secret値を同一プロセスメモリだけで初期化する
3. Runtime Secretのexact ARNをOperator policyへ追加して再provisionする
4. Release B application Change Setをexecution role付きで作成する
5. Remove 0、Replacement 0、production/staging混在0を確認する
6. migration dry-runの既存結果（自動5、manual 0、unknown/conflict 0）と対象identityを照合する
7. application Change Setを実行する
8. kill switch、Worker ESM、Bedrockが安全側であることを確認する
9. conditional・idempotent migrationをapplyする
10. migration前後の件数、owner、plan、quotaを照合する
11. production APIとVercelの非Secret URL設定を接続する
12. Light、Deep、Voiceを段階的に有効化してsmokeする
13. 指定済み内部βaccountで各1回E2Eする
14. productionカード決済とfincode PRODはdisabledのまま最終確認する

このブートストラップでは、Release B application deploy、migration apply、Runtime Secret値の作成、Vercel変更、Bedrock実行、fincode通信を行いません。

## 2026-08-06 bootstrap実行結果

- organization Identity Center instance: 一意性確認済み
- USER `Kokuryu3`: `get-user-id`と`describe-user`の照合済み（opaque IDは記録していません）
- Permission Set: `NanaProductionReleaseBOperator` provision済み
- AWS managed policy: 0
- customer managed policy: 0
- Runtime Secret権限: Secret未作成のため未付与
- bootstrap stack: `CREATE_COMPLETE`
- execution role: exact policy／CloudFormation service trust確認済み
- production運用profile: `nana-production-release-b` READY
- read-only smoke: PASS
- canonical application stack: 未作成
- Release B application apply: 未開始
