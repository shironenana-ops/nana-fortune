# Vercel Preview security validation — 2026-07-18

## 現在の判定

`REMOTE_PATH_OVERRIDE_VERIFIED_ASTRO_IMAGE_RETEST_PENDING`

Phase Bの実測ではPath Override 4ケースがすべてPASSし、主要smokeも15件PASSした。唯一のFAILは、remote probeがHTML内で画像より先に現れたAstro CSS assetを画像候補として選択したことによるfalse failureである。Path Overrideの再現、アプリ障害、画像配信障害を示すものではない。

旧出力の`SECURITY_REMEDIATION_FAILED`は確定判定として扱わない。修正版probeによる実Preview再試験は、この変更では実施していない。

## 安全記録

- 対象：ユーザーが明示したVercel Preview
- URL guard：PASS
- production request：0
- cross-host redirect追従：0
- AWS／Bedrock／DynamoDB実行：0
- 実token／実鑑定入力：不使用
- `READING_DEEP_GENERATE_API_ENABLED`：未設定
- `automation_bypass_configured: true`
- Secretの値、長さ、断片、hash：保存なし
- response本文、Cookie、認証情報、Preview hostname、request ID：保存なし

## Path Override matrix

| ID | 検証 | 実測結果 |
|---|---|---|
| PO-01 | GET header | PASS |
| PO-02 | POST header | PASS |
| PO-03 | GET query | PASS |
| PO-04 | POST query | PASS |

## Smoke test

- PASS：15
- remote probe上のFAIL：1
- 確認対象：`SMOKE-ASTRO-IMAGE`
- 誤選択したasset種別：stylesheet
- response status：200
- content-type：`text/css; charset=utf-8`
- 判定：`FALSE_FAILURE_ASSET_SELECTION`

`SMOKE-PUBLIC-IMAGE`はPASSしている。CSS responseを画像障害として扱わない。

## Probe修正

- 汎用的な最初の`/_astro/`参照を画像候補にしない。
- `img src`、`img srcset`、`picture`内の`source srcset`から画像候補を抽出する。
- `.css`、`.js`、`.map`、fontを画像候補から除外する。
- `content-type`が`image/*`の場合だけ`SMOKE-ASTRO-IMAGE`をPASSにする。
- 最適化画像候補がなければ`NOT_APPLICABLE_NO_OPTIMIZED_IMAGE`とし、FAILにしない。
- CSSが画像より前に現れるfixtureと、最適化画像なしのfixtureを回帰テストに含める。

## ローカル回帰

- probe unit test：10 pass / 0 fail / 0 skipped
- `npm test`：119 pass / 0 fail / 0 skipped
- Node.js 22.23.1：119 pass / 0 fail / 0 skipped
- `npm run build`：PASS
- TypeScript 5.9.3 `tsc --noEmit`：PASS
- `git diff --check`：PASS
- 実Preview／productionへのHTTP通信：0

## 証跡

- `docs/security/evidence/vercel-preview-path-override-2026-07-18.json`
- Phase B実測値はユーザーから提示された安全化済み結果を反映した。
- 実Secret、Preview hostname、生responseは含めていない。
