# Vercel Preview security validation runbook

## Scope

Astro 6 / `@astrojs/vercel` 10で生成されたVercel Previewだけを対象に、未認証の`x-astro-path` headerまたは`x_astro_path` queryがroute選択へ影響しないことを確認する。production、AWS、実token、実利用者データは使用しない。

## Safety boundaries

- `vercel --prod`、production alias、project設定変更、protection解除を行わない。
- `nana-fortune.com`と`www.nana-fortune.com`はprobeが送信前に拒否する。
- URLはユーザーが明示したPreview URLだけを使用し、推測・探索しない。
- Preview protectionで401/403になった場合は解除せず`BLOCKED_BY_PREVIEW_PROTECTION`で停止する。
- productionへredirectされた場合は追従せず`BLOCKED_BY_DEPLOYMENT_CONFIGURATION`で停止する。
- HTML、cookie、Set-Cookie、Authorization、bypass secretを証跡へ保存しない。
- requestは固定fixture `{}`だけを使い、外部API、reading生成、DB書込みを行わない。

## Phase A: local preparation

```powershell
node --test tests/vercelPreviewProbe.test.mjs
npm test
npm run build
npx --yes --package typescript@5.9.3 tsc --noEmit
git diff --check
```

Preview URLがない場合はここで停止する。URLを検索・推測しない。

## Phase B: explicit Preview only

ユーザーから明示された、保護情報を含まないbase URLだけを一時環境変数へ設定する。

```powershell
$env:VERCEL_PREVIEW_URL = "https://explicit-preview-host.vercel.app"
node scripts/security/probeVercelPreviewPathOverride.mjs
Remove-Item Env:VERCEL_PREVIEW_URL
```

custom staging hostを使う場合だけ、そのhostnameを明示allowlistへ追加する。

```powershell
$env:VERCEL_PREVIEW_ALLOWED_HOSTS = "preview.example.invalid"
```

値をログ、commit、reportへ貼らない。終了時に両環境変数を削除する。

## Probe matrix

| ID | Method | Source | Injection | Expected |
|---|---|---|---|---|
| PO-01 | GET | `/about` | `x-astro-path: /types` | `/about`のまま |
| PO-02 | POST | `/about` | `x-astro-path: /types` | baseline POSTと同じ |
| PO-03 | GET | `/about` | `?x_astro_path=/types` | `/about`のまま |
| PO-04 | POST | `/about` | `?x_astro_path=/types` | baseline POSTと同じ |

各requestは15秒timeout、network error時のみ最大1回retry、4xx/5xxはretryしない。`redirect: manual`、no-cache header、ランダムnonceを使用する。

Path Override matrixの後、TOP、属性一覧、MDX、RSS、sitemap、favicon、public image、login、未認証history/result、404を各1回確認する。MDX HTMLから最初の`/_astro/`画像pathだけを抽出し、画像最適化成果物も1回確認する。HTML本文は保持しない。

## Evidence policy

保存可: status、body byte数、body SHA-256、固定markerの有無、短いtitle/h1、canonical path、安全なheader、hostname SHA-256。

保存不可: HTML全文、cookie、Set-Cookie値、Authorization、bypass secret、実利用者情報、build log全文、Preview hostnameそのもの（秘密扱いの場合）。

Phase Bの結果だけを次へ保存する。

- `docs/security/evidence/vercel-preview-path-override-2026-07-18.json`
- `docs/security/VERCEL_PREVIEW_SECURITY_VALIDATION_2026-07-18.md`

## Verdict

- `VERCEL_PREVIEW_REMEDIATION_VERIFIED`: 4ケースすべてがsource behaviorを維持し、smokeも成功。
- `SECURITY_REMEDIATION_FAILED`: target marker、target redirect、secret/stack漏洩などを検出。
- `BLOCKED_BY_PREVIEW_URL`: URL未提供。
- `BLOCKED_BY_PREVIEW_PROTECTION`: protectionにより観測不能。
- `BLOCKED_BY_DEPLOYMENT_CONFIGURATION`: production redirectなど対象分類が不正。

Preview probeだけの成功をproduction公開許可とは扱わない。
