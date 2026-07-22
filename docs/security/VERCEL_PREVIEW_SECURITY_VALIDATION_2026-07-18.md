# Vercel Preview security validation — Phase B final

## 最終判定

`VERCEL_PREVIEW_REMEDIATION_VERIFIED`

修正版probeによるVercel Preview再試験では、Path Override 4ケースとsmoke 16ケースがすべてPASSした。`SMOKE-ASTRO-IMAGE`も実画像を選択し、HTTP 200・`image/webp`でPASSした。

この判定は、ユーザーがターミナル上で確認したprobe自身の最終出力と終了コード0を、安全化済み実測値として反映したものである。

## Path Override matrix

| ID | 検証 | 最終結果 |
|---|---|---|
| PO-01 | GET `x-astro-path` header | PASS |
| PO-02 | POST `x-astro-path` header | PASS |
| PO-03 | GET `x_astro_path` query | PASS |
| PO-04 | POST `x_astro_path` query | PASS |

## Smoke test

- PASS：16
- FAIL：0
- NOT_APPLICABLE：0
- `SMOKE-ASTRO-IMAGE`：PASS
- `SMOKE-ASTRO-IMAGE` status：200
- `SMOKE-ASTRO-IMAGE` content-type：`image/webp`
- probe exit code：0

## 旧false failureの整理

旧`SECURITY_REMEDIATION_FAILED`は、CSS assetを画像として選択した旧probeの`FALSE_FAILURE_ASSET_SELECTION`であり、最終判定から除外した。修正版ではHTMLの画像要素から候補を取得し、`image/*`だけをPASSにする。

Windows PowerShell 5.1の`Tee-Object`経由で文字化け・構文破損した次の未追跡ファイルは、正式証跡として使用・commitしない。

- `docs/security/evidence/vercel-preview-path-override-retest-2026-07-18.json`

正式な機械可読証跡は次のファイルだけとする。

- `docs/security/evidence/vercel-preview-path-override-2026-07-18.json`

## 安全記録

- production requests：0
- `productionHostRejected`：true
- `automation_bypass_configured: true`
- Automation Bypass Secret：値、長さ、断片、hashを保存していない
- 再試験後のPowerShell環境変数：削除済み
- Vercel側の一時Secret：削除済み
- response本文、Cookie、認証情報、Preview hostname、request ID：正式証跡へ保存していない
- AWS／Bedrock／DynamoDB接続：なし
- `READING_DEEP_GENERATE_API_ENABLED`：未設定

## ローカル回帰

- `npm test`：119 pass / 0 fail / 0 skipped
- Node.js 22.23.1：119 pass / 0 fail / 0 skipped
- `npm run build`：PASS
- TypeScript 5.9.3 `tsc --noEmit`：PASS
- `npm audit --omit=dev`：total 9 / critical 0 / high 6 / moderate 2 / low 1
- 依存更新・`npm audit fix`：未実施
- `git diff --check`：PASS
- 秘密情報検査：PASS
