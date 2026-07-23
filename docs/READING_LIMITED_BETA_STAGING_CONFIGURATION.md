# 限定β向けstaging設定方針

更新日: 2026-07-23

この文書は、承認済みのモデル候補とRate Limit値をstagingで再検証するための非秘密情報だけを示します。完全な環境変数ファイルではなく、productionへそのまま投入する手順でもありません。

## 現在のgate

```text
MODEL_ROUTING_IMPLEMENTATION: VERIFIED_LOCALLY
LIGHT_MODEL_STAGING_CANDIDATE: CONFIGURED_NOT_ENABLED
DEEP_MODEL_STAGING_CANDIDATE: CONFIGURED_NOT_ENABLED
RATE_LIMIT_POLICY_VALUES: APPROVED_FOR_LIMITED_BETA
RATE_LIMIT_POLICY_EFFECTIVE: NO
GLOBAL_PROFILE_USED: NO
LIMITED_PAID_BETA_GATE: BLOCKED_BY_INFRA_AND_STAGING
```

`READING_GENERATE_API_ENABLED`、`READING_DEEP_GENERATE_API_ENABLED`、`READING_BEDROCK_ENABLED`はいずれもUNSETまたはFALSEを維持します。

## 非秘密のモデル候補

| 項目 | staging候補 | 状態 |
|---|---|---|
| AWS region | `ap-northeast-1` | 未適用 |
| light model | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | 設定候補、未有効化 |
| deep model | `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` | 設定候補、未有効化 |
| processing scope | `JAPAN` | Global profile不使用 |

実装が読むmodel設定名は`BEDROCK_LIGHT_MODEL_ID`、`BEDROCK_LIGHT_MODEL_ALIAS`、`BEDROCK_DEEP_MODEL_ID`、`BEDROCK_DEEP_MODEL_ALIAS`です。旧`BEDROCK_MODEL_ID`と`BEDROCK_MODEL_ALIAS`はfallbackとして使用しません。

## 承認済みRate Limit値

| scope | max attempts | window seconds |
|---|---:|---:|
| free/free | 10 | 600 |
| light/free | 10 | 600 |
| light/light | 3 | 900 |
| premium/free | 10 | 600 |
| premium/light | 5 | 900 |
| premium/deep | 2 | 1800 |

light/deepの同時実行上限は各1です。これらは`READING_RATE_LIMIT_POLICY_APPROVED_2026-07-23.json`に承認済み候補として固定していますが、runtimeはJSONを自動読込せず、明示された環境変数だけを使用します。

## stagingで人間が設定するもの

秘密値、物理table名、account ID、ARN、実originはこの文書へ記載しません。stagingでは承認された管理経路から、次の名前に対応する値を個別設定します。

- Rate Limit用DynamoDB table名
- HMAC参照生成用secret
- concurrency lease秒数
- staging allowed origin
- budget alarmと運用通知先

concurrency leaseには、次を満たす値を人間が決定します。

```text
concurrency lease > Bedrock timeout + persistence/cleanup buffer
```

## 有効化前の再検証

- lightとdeepが別々のmodel IDへrouteされること
- forced tool-use、server validator、canonical fallbackが維持されること
- Rate Limit 6 scopeとconcurrency 1/1がstaging設定と一致すること
- token、latency、fallback、429、`Retry-After`、失敗後のlease解放を観測すること
- secret、raw user ID、質問、鑑定本文、AWS request IDをログへ残さないこと
- kill switchをFALSEへ戻すだけでcanonicalへ切り戻せること

これらの検証とinfra/IAM/監視の承認が完了するまで、限定βgateは開きません。
