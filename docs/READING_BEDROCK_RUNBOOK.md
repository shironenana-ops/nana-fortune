# Bedrock文章整形 運用手順

## 権限

Lambda実行ロールには対象modelまたはinference profileへ限定した`bedrock:InvokeModel`だけを付与します。streamingを使わないため`bedrock:InvokeModelWithResponseStream`は不要です。AdministratorAccess、BedrockFullAccess、アクセスキー発行は行いません。正確なResource ARNが未確認なら`*`で本番確定せず、確認待ちとして扱います。

## ローカル確認

通常テストはAWSへ接続しません。明示的な有料smoke testだけ、既存のAWS標準認証チェーンと確認済みmodel IDを用いて次を実行します。

```powershell
$env:READING_BEDROCK_SMOKE='true'
$env:READING_BEDROCK_ENABLED='true'
$env:AWS_REGION='ap-northeast-1'
$env:BEDROCK_LIGHT_MODEL_ID='<確認済みlight IDまたはARN>'
$env:BEDROCK_DEEP_MODEL_ID='<確認済みdeep IDまたはARN>'
$env:READING_BEDROCK_TIMEOUT_MS='90000'
npm run test:reading-bedrock-smoke
```

架空データ1件のlight鑑定を1回だけ呼びます。本文、prompt、資格情報は表示しません。失敗時に自動再試行しません。

2026-07-17、日本向けGeo inference profile `jp.anthropic.claude-haiku-4-5-20251001-v1:0`で最小Converse呼び出しのHTTP 200を確認しました。当時の単一model設定はPhase Aの履歴であり、現在はlight/deep別の環境変数から渡します。同日の架空light smokeは20,018msでcanonical fallbackし、当時の20,000ms timeout到達が原因と判断しました。再確認時は`READING_BEDROCK_TIMEOUT_MS=90000`を明示できます。

2026-07-23時点のstaging候補は、lightが`jp.anthropic.claude-haiku-4-5-20251001-v1:0`、deepが`jp.anthropic.claude-sonnet-4-5-20250929-v1:0`です。いずれもコードへ固定せず、候補として文書化しただけで有効化していません。Global inference profileは使用せず、`ap-northeast-1`／`JAPAN`境界を維持します。

90,000msへ変更後の架空light smokeは21,500msで応答し、`invalid_output`でcanonical fallbackしました。接続とtimeoutは正常で、厳格validatorとモデル出力形式の不一致が原因でした。

同じJP Geo inference profileで、Structured Outputsの`outputConfig.textFormat`はHTTP 400（未対応field）、tool定義の`strict: true`もHTTP 400（未対応field）になることを確認しました。一方、`strict`を付けず`toolChoice.tool`で`shirone_render`を強制した最小ConverseはHTTP 200、`stopReason: tool_use`、tool inputありで成功しました。そのため現在はforced tool-useを採用し、`strict`と`outputConfig`を送りません。tool schemaはモデル誘導であり、unknownのtool inputを検証するNode側validatorが最終保証境界です。AWS側の対応状況が変わっても、再検証なしにStructured Outputsへ戻しません。自動再試行は追加せず、SDK `maxAttempts: 1`を維持します。

forced tool-useへ切り替えた後、同じmodel IDによる架空light smokeを実行し、21,669msで`rendered`になったことを確認しました。採用されたcanonical sectionは6件、整形後の本文は合計2,177文字で、canonical fallbackは発生しませんでした。smoke出力および記録には、生モデル出力、PII、認証情報を含めていません。この結果は当該model ID、入力、実行時点における1件の疎通確認であり、常時の成功、品質、応答時間を保証するものではありません。

Windows PowerShellで確認されたtool inputの日本語文字化けは、表示・デコード経路の問題です。Node.js AWS SDK内のUTF-8処理とは分けて扱います。

smokeの`fallback_reason`は`timeout`、`provider_error`、`invalid_output`、`configuration_error`だけです。`invalid_output_detail`は`json_parse`、`schema_version`、`section_shape`、`section_set`、`section_order`、`body_constraints`、`stop_reason`、`tool_missing`、`tool_count`、`tool_name`、`tool_input`、`unknown`だけです。生tool input、schema error、AWS request ID、モデル本文、prompt、PIIは出力しません。

## 障害時

`READING_BEDROCK_ENABLED`をfalseまたは未設定へ戻します。timeout、throttling、access denied、model unavailable、不正JSON、schema不一致、セクション不整合、巨大出力は、モデル本文を混ぜずcanonical結果へfallbackします。
