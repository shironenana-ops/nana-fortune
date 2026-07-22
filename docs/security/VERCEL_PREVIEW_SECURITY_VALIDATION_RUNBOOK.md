# Vercel Preview security validation runbook

## 目的

Astro 6／`@astrojs/vercel` 10で生成したVercel Previewだけを対象に、`x-astro-path` headerまたは`x_astro_path` queryによって内部pathが変更されないことを確認する。本番、AWS、実token、実ユーザーデータは使用しない。

## 安全境界

- ユーザーが明示したHTTPSのPreviewベースURLだけを使用し、URLを推測・探索しない。
- `nana-fortune.com`と`www.nana-fortune.com`は送信前に拒否する。
- URLはcredential、path、query、fragment、非標準port、IP、localhost、`.local`、Unicode／punycode hostを拒否する。
- `redirect: manual`とし、本番へのredirectは追従せず`BLOCKED_BY_DEPLOYMENT_CONFIGURATION`で停止する。
- Vercel SSOへの302、またはPreview Protectionを示す401／403は、解除・回避せず`BLOCKED_BY_PREVIEW_PROTECTION`で停止する。
- Automation Bypassを使う場合は、ユーザーが実行環境へ設定した`VERCEL_AUTOMATION_BYPASS_SECRET`だけを読み、URL安全判定後に同一Preview hostへの`x-vercel-protection-bypass` headerとして送る。query方式は使用しない。
- Bypass Secretは値、長さ、断片、hashを出力・証跡・例外へ残さない。cross-host redirectへheaderを転送しない。
- request bodyは固定fixture `{}`だけとし、reading生成、DB書込み、AWS接続を行わない。
- HTML本文、Cookie、Set-Cookie、Authorization、bypass secret、redirect query、nonce、AWS／Vercel request ID、Preview hostnameを証跡へ保存しない。
- 保存できるのはstatus、body byte数、body SHA-256、固定marker、短いtitle／h1、canonical path、安全なheader、hostname SHA-256だけとする。

## Phase A：ローカル準備

```powershell
node --test tests/vercelPreviewProbe.test.mjs
npm test
npm run build
npx --yes --package typescript@5.9.3 tsc --noEmit
git diff --check
```

Preview URLが明示されていない場合は`BLOCKED_BY_PREVIEW_URL`で停止する。

## Phase B：明示されたPreviewだけ

```powershell
$env:VERCEL_PREVIEW_URL = "https://explicit-preview-host.vercel.app"
$env:VERCEL_AUTOMATION_BYPASS_SECRET = Read-Host -MaskInput "Automation Bypass Secret"
node scripts/security/probeVercelPreviewPathOverride.mjs
Remove-Item Env:VERCEL_PREVIEW_URL
Remove-Item Env:VERCEL_AUTOMATION_BYPASS_SECRET
```

環境変数の値、長さ、断片、hash、hostname、認証情報をログやcommitへ保存しない。報告できるのは`automation_bypass_configured: true/false`だけとする。

## Path override matrix

| ID | Method | Source | Injection | Expected |
|---|---|---|---|---|
| PO-01 | GET | `/about` | `x-astro-path: /types` | `/about`の挙動を維持 |
| PO-02 | POST | `/about` | `x-astro-path: /types` | baseline POSTと同じ |
| PO-03 | GET | `/about` | `?x_astro_path=/types` | `/about`の挙動を維持 |
| PO-04 | POST | `/about` | `?x_astro_path=/types` | baseline POSTと同じ |

各requestは15秒timeout、network errorのみ最大1回retry、HTTP errorはretryしない。matrix成功後にTOP、属性一覧、MDX、RSS、sitemap、favicon、public image、Astro最適化画像、login、未認証history/result、404を確認する。

Astro最適化画像は、MDX HTMLの`img src`、`img srcset`、`picture`内の`source srcset`だけから同一originの`/_astro/`候補を選ぶ。`.css`、`.js`、`.map`、fontは候補から除外し、取得結果の`content-type`が`image/*`の場合だけPASSとする。候補が存在しない場合は`NOT_APPLICABLE_NO_OPTIMIZED_IMAGE`とし、FAILにしない。`SMOKE-PUBLIC-IMAGE`は別項目として常に維持する。

## 証跡

- JSON：`docs/security/evidence/vercel-preview-path-override-2026-07-18.json`
- Markdown：`docs/security/VERCEL_PREVIEW_SECURITY_VALIDATION_2026-07-18.md`

`BLOCKED`を`PASS`として扱わない。Protectionで観測不能なら解除せず、保護された状態を記録して停止する。

## 判定

- `VERCEL_PREVIEW_REMEDIATION_VERIFIED`：4ケースとsmokeがすべて成功。
- `SECURITY_REMEDIATION_FAILED`：target routeへの変更、情報漏えい、予期しない挙動を検出。
- `BLOCKED_BY_PREVIEW_URL`：URL未提供。
- `BLOCKED_BY_PREVIEW_PROTECTION`：Vercel保護によりアプリ挙動を観測不能。
- `BLOCKED_BY_DEPLOYMENT_CONFIGURATION`：本番redirectなど対象構成が不正。
