# Bedrock文章整形基盤

白音七の自前エンジンを鑑定内容の正本とし、Amazon Bedrock Runtime上のmode別モデルにはlight／deep本文の文章整形だけを委ねます。数秘、星座、波、属性、mode、セクション構成、`oneStep`、`avoidHint`は変更させません。freeはBedrockを呼びません。

使用技術はAWS SDK for JavaScript v3の`BedrockRuntimeClient`と`ConverseCommand`です。Mantle、OpenAI互換API、APIキー、ブラウザからの直接呼び出しは使用しません。model IDまたはinference profile IDは、lightを`BEDROCK_LIGHT_MODEL_ID`、deepを`BEDROCK_DEEP_MODEL_ID`で渡し、ソースへ固定しません。任意の表示用aliasは`BEDROCK_LIGHT_MODEL_ALIAS`と`BEDROCK_DEEP_MODEL_ALIAS`です。旧`BEDROCK_MODEL_ID`と`BEDROCK_MODEL_ALIAS`はfallbackとして使用しません。

環境変数は`READING_BEDROCK_ENABLED=true`、`AWS_REGION`、light/deep双方のmodel ID、任意の`READING_BEDROCK_TIMEOUT_MS`です。timeoutの既定値は60,000ms、許容範囲は5,000〜180,000msです。有効時に片方でもmodel IDが欠ける場合はfail closedします。無効時はmodel ID不足だけでは起動失敗させずcanonical出力を維持します。障害時は`READING_BEDROCK_ENABLED`を無効化して切り戻します。

rendererはcanonical inputの`mode`だけでmodelを選びます。lightはlight設定と5,000 max tokens、deepはdeep設定と12,000 max tokensを使用します。freeまたは未知modeがrendererへ到達した場合は、providerへ送信する前に拒否します。mode間でmodel IDやaliasを流用しません。

prompt versionは`shirone-reading-prose-prompt-v2`です。SDK maxAttemptsは1、temperatureは0.2です。`top_p`は同時指定しません。

Claude Haiku 4.5には`shirone_render`を1件だけ定義し、`toolChoice.tool.name`で強制するforced tool-useを使用します。`strict`と`outputConfig`は送りません。light／deepごとにcanonical section IDを固定propertyとするtool input schemaを生成し、`additionalProperties: false`と全sectionの`required`を設定します。tool schemaはモデル誘導であり、最終保証境界ではありません。`toolUse.input`をunknownとしてNode側validatorへ渡し、canonical順へ再構築した後も空本文、型、制御文字、文字数上限を検査します。`stopReason`が`tool_use`でない応答、toolが1件以外、tool名不一致、通常textを伴う応答は採用しません。tool結果を返す第2ターンは行いません。
