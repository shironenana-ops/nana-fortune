# Bedrockモデル・生成原価・Rate Limit Phase A判断

調査日: 2026-07-23

対象: 日本版（source `ap-northeast-1`、processing scope `JAPAN`）

状態: 調査・試算・提案のみ。production設定、AWS接続、Bedrock実行は未実施。

## 結論

```text
PRIMARY_REGION: ap-northeast-1
PROCESSING_SCOPE: JAPAN
MODEL_ROUTING_RECOMMENDATION: MODE_SPECIFIC_MODELS
LIGHT_MODEL_RECOMMENDATION: jp.anthropic.claude-haiku-4-5-20251001-v1:0
DEEP_MODEL_RECOMMENDATION: jp.anthropic.claude-sonnet-4-5-20250929-v1:0
LIGHT_INFERENCE_SCOPE: JAPAN (Tokyo/Osaka Geo Cross-Region)
DEEP_INFERENCE_SCOPE: JAPAN (Tokyo/Osaka Geo Cross-Region)
GLOBAL_PROFILE_USED: NO
RATE_LIMIT_POLICY_RECOMMENDATION: COMPLETE
RATE_LIMIT_POLICY_VALUES: PENDING_HUMAN_APPROVAL
LIMITED_PAID_BETA_GATE: BLOCKED
```

lightは低原価と既存実測を優先してHaiku 4.5、deepは10,000〜30,000字の商品品質を優先してSonnet 4.5を第一候補とする。これはproduction採用確定ではなく、stagingで日本語品質・token量・latency・fallback率を比較するための推奨である。

## 証拠の区分

- **公式事実**: AWS公式ページで2026-07-23に確認した仕様・料金・提供地域。
- **ローカル事実**: このrepositoryのコード、試験、既存runbookに記録された内容。
- **推定／提案**: CountTokensを使わないtoken仮定、原価、Rate Limit値、routing案。
- **未確認**: 本番相当の日本語品質、実token、P95 latency、quota、課金失敗時の請求確定値。

## 公式モデル比較

| 項目 | Claude Haiku 4.5 | Claude Sonnet 4.5 |
|---|---|---|
| lifecycle | Active | Active |
| launch | 2025-10-16 | 2025-09-30 |
| EOL | no sooner than 2026-10-01 | no sooner than 2026-09-29 |
| context / max output | 200K / 64K | 200K / 64K |
| Converse | 対応 | 対応 |
| tool use / forced tool choice | 対応 | 対応 |
| Tokyo In-Region | 対応 | 非対応 |
| Tokyo source JP Geo | 東京・大阪 | 東京・大阪 |
| JP Geo ID | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Japan price / 1M tokens | input $1.10 / output $5.50 | input $3.30 / output $16.50 |

AWSの一般model cardはStructured Outputs対応を示すが、白音七の2026-07-17実測ではJP Geo + Converseの`outputConfig.textFormat`とtool `strict`がHTTP 400だった。このため現行実装はforced tool-useとNode側validatorを安全境界としており、今回も変更しない。公式能力表示と実際のAPI/profile組合せの差はstaging再検証事項である。

旧Claude 3/3.5系は2026-07-30 EOLが示されており、新規launch候補から除外する。4.5系もno-sooner-than日が近いため、月次確認に加え180/90/60/30日前の移行手順を運用する。正式なreplacementは未発表のため記載しない。

公式資料:

- AWS model card, Haiku 4.5: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
- AWS model card, Sonnet 4.5: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html
- AWS Japan Geo announcement and price table: https://aws.amazon.com/jp/blogs/news/amazon-bedrock-now-supports-japan-cross-region-inference/
- AWS model lifecycle: https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html
- AWS Claude tool-use token overhead: https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-tool-use.html

## 現行実装とrouting案

ローカル事実として、`bedrockReadingProseRenderer.ts`は単一の`BEDROCK_MODEL_ID`をlight/deepで共用し、Converse forced tool-use、`maxAttempts: 1`、light 5,000／deep 12,000 output tokenを設定する。tool定義自体にも課金対象tokenが含まれ、forced `tool` choiceのClaude 4.5追加system promptはAWS公式表で313 tokenである。

Phase B候補は`BEDROCK_LIGHT_MODEL_ID`と`BEDROCK_DEEP_MODEL_ID`への分離である。config、IAM resource、smoke matrix、kill switchがモデル別に増える。Phase Aではソース・IAM・環境変数を変更しない。

## token推定と原価

CountTokens、AWS、外部tokenizerは使用していない。system、user JSON、canonical reading、質問・表示名、tool description/schema、tool choice、313-token overhead、protocol余白を含めるため、本文文字数だけではなく以下の保守的な入力token帯を置く。

| mode | ケース | input | output | 根拠の性質 |
|---|---:|---:|---:|---|
| light | P50 | 6,000 | 3,000 | 推定 |
| light | P95 | 10,000 | 5,000 | 推定、現行output上限 |
| light | configured max exposure | 20,000 | 5,000 | 保守的上限仮定 |
| light | abnormal accepted | 30,000 | 5,000 | 入力validator内の異常上振れ仮定 |
| deep | P50 | 15,000 | 8,000 | 推定 |
| deep | P95 | 30,000 | 12,000 | 推定、現行output上限 |
| deep | configured max exposure | 50,000 | 12,000 | 保守的上限仮定 |
| deep | abnormal accepted | 80,000 | 12,000 | 入力validator内の異常上振れ仮定 |

30,000日本語字を12,000 output tokenで安定して満たせる保証はない。stagingで実tokenと文字数を測り、商品表現または上限を別承認で調整する。

### 1回あたり（USD / JPY、140・160・180円）

| mode/model | case | USD | JPY@140 | JPY@160 | JPY@180 |
|---|---|---:|---:|---:|---:|
| light/Haiku | P50 | 0.0231 | 3.23 | 3.70 | 4.16 |
| light/Haiku | P95 | 0.0385 | 5.39 | 6.16 | 6.93 |
| light/Haiku | max | 0.0495 | 6.93 | 7.92 | 8.91 |
| light/Haiku | abnormal | 0.0605 | 8.47 | 9.68 | 10.89 |
| deep/Sonnet | P50 | 0.1815 | 25.41 | 29.04 | 32.67 |
| deep/Sonnet | P95 | 0.2970 | 41.58 | 47.52 | 53.46 |
| deep/Sonnet | max | 0.3630 | 50.82 | 58.08 | 65.34 |
| deep/Sonnet | abnormal | 0.4620 | 64.68 | 73.92 | 83.16 |

timeout/provider failureは請求tokenが応答前に確定できない。ゼロ円と仮定せず、運用上は当該modeのconfigured maxを1 attemptの予算露出として扱う。canonical fallback自体に追加Bedrock費用はないが、その前の失敗attemptは課金され得る。

### 月間シナリオ（160円/USD、P50）

| mode | 1回 | 3回 | 10回 | 30回 | 100回 |
|---|---:|---:|---:|---:|---:|
| light/Haiku | 3.70円 | 11.09円 | 36.96円 | 110.88円 | 369.60円 |
| deep/Sonnet | 29.04円 | 87.12円 | 290.40円 | 871.20円 | 2,904.00円 |

既知のfincode販売手数料7%だけを差し引くと、980円は911.40円、2,980円は2,771.40円。light P50 30回は売価の11.31%（手数料後残額の12.17%）、deep P50月3回は売価の2.92%（同3.14%）。税、返金、インフラ、MOSHの追加費用は未確認のため粗利とは呼ばない。

## Rate Limit提案

| scope | 提案 | 用途 |
|---|---|---|
| free/free | 10 / 10分 | 非Bedrock、誤連打とAPI保護 |
| light/free | 10 / 10分 | 非Bedrock |
| light/light | 3 / 15分 | 通常操作と1回程度の失敗retry |
| premium/free | 10 / 10分 | 非Bedrock |
| premium/light | 5 / 15分 | premium通常鑑定の質問修正余地 |
| premium/deep | 2 / 30分 | deep月3回とは別に失敗retry余地 |

concurrencyはlight/deepとも1。固定窓は境界直前・直後に2倍burstを許す。したがって最悪短時間attemptはlight会員6、premium light 10、deep 4。concurrency 1により同時実行は抑えるが逐次burstは残る。現基盤のまま限定βでは受容候補とし、観測で悪用・retry loopが出た場合はsliding windowを別課題にする。

160円/USD・configured maxで機械的に全枠消費した場合、premium/lightは1時間20 attempts=158.40円、1日480 attempts=3,801.60円。light/lightは1時間12 attempts=95.04円、1日288 attempts=2,280.96円。premium/deepはRate Limitだけなら1時間4 attempts=232.32円、1日96 attempts=5,575.68円だが、実際はdeep月3回quotaが別途先に制約する。これらは一人が全窓を最大消費する防御設計用上限で、通常利用予測ではない。

値の機械可読な正本候補は`READING_RATE_LIMIT_POLICY_PROPOSAL_2026-07-23.json`。まだ環境変数へ設定しない。

## stagingで必ず測るもの

model/profile ID、region、mode、input/output token、latency P50/P95/max、stop reason、rendering/fallback status、固定allow-list fallback reason、HTTP status、Retry-After、推定USD/JPYを集計する。氏名、生年月日、質問・鑑定本文、raw user ID、session token、Idempotency-Key、HMAC参照は記録しない。

lightはHaikuとSonnetの日本語自然さ・重複・fallback・latency・原価を比較する。deepはHaiku/Sonnet双方で10,000〜30,000字の完遂率、12,000-token打切り、section validator通過率を比較する。品質評価基準と合格閾値は人間承認が必要である。

## 未確定と承認事項

- mode別model設定とIAM変更
- Rate Limit 6値とconcurrency値
- 実測token/latency/品質/fallback率の合格基準
- AWS account quota、budget alarm、1日費用上限
- 4.5後継modelと移行日程
- lightの商品上の月間利用回数（Rate Limitとは別）

以上が承認・staging検証されるまで`LIMITED_PAID_BETA_GATE`は`BLOCKED`とする。

## Phase Aローカル検証

- `npm test`: 最終 132 pass / 0 fail / 0 skipped。初回は並列テストが共有`dist/reading-server-foundation`を再生成する競合とみられる10件の一時失敗があり、同一変更の再実行では再現しなかった。
- Node.js 22.23.1: 全132件 pass。
- `npm run build`: PASS（Astro SSR / Vercel artifact）。
- TypeScript 5.9.3 `tsc --noEmit`: PASS（一時実行、dependency追加なし）。
- `build:reading-server` / `build:reading-foundation` / `build:reading-api-handler`: PASS。
- calculator unit test: 2 pass。
- `git diff --check`: PASS。
- secret pattern scan: 該当なし。
- `npm audit --omit=dev`: critical 0 / high 6 / moderate 2 / low 1、合計9。指示された既知baselineと一致し、fixは未実施。
- `package.json`、`package-lock.json`、production source、環境変数、Rate Limit実装値は変更していない。
