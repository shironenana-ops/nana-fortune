# Astro 6 / Vercel path override remediation

検証日: 2026-07-18

対象: `C:\work\nana-fortune`

開始時main: `c7ccfcc41a2ed92b34819fb6f3965dc574b00227`（PR #83反映済み）

監査commit: `23c68a03a6c6bc3eb0aac0c5c40c8faa0cd48939`（監査専用branchに保持、upgradeへ混在させていない）

## 判定

ローカル判定は **`REMEDIATION_VERIFIED_LOCALLY`** とする。

- `GHSA-mr6q-rp88-fx84` / `CVE-2026-33768` の影響範囲だった `@astrojs/vercel@8.2.11` を、修正版の `10.0.8` へ更新した。
- 生成handlerに対する未認証の `x-astro-path` headerおよび `x_astro_path` queryのGET/POST 4ケースは、いずれも指定元routeから別routeへ移動しなかった。
- Astro 6、SSR、認証関連画面、MDX、RSS、sitemap、画像、404、500 fixture、reading成果物のローカル回帰は成功した。
- production / Vercel / AWSへの接続・deployは実施していない。次工程はVercel previewまたは限定stagingである。

この判定はproduction readyや無条件の安全保証を意味しない。

## Version selection

npm registryのstable release、peer dependency、Node要件を確認し、prerelease、Astro 7、adapter 11を除外した。

| Package | Before | After | 理由 |
|---|---:|---:|---|
| `astro` | 5.15.4 | 6.4.8 | Astro 6系stable、Node `>=22.12.0` |
| `@astrojs/vercel` | 8.2.11 | 10.0.8 | Astro 6対応、対象advisory修正版（10.0.2以上） |
| `@astrojs/mdx` | 4.3.10 | 5.0.6 | Astro 6 peer互換 |
| `@astrojs/sitemap` | 3.6.0 | 3.7.3 | Astro 6 build hook互換 |
| `@astrojs/rss` | 4.0.13 | 4.0.19 | Astro 6 / Zod 4 runtime互換とRSS 500解消 |
| `sharp` | 0.34.5 | 0.34.5 | 変更不要 |
| AWS SDK 2種 | 3.1089.0 | 3.1089.0 | 変更禁止範囲のため不変 |

`package.json`の既存caret方針を維持した。`npm audit fix`、`--force`、`--legacy-peer-deps`、override、一括更新は使用していない。

直接dependencyにはprereleaseを選択していない。lockfileには`get-tsconfig@5.0.0-beta.4`が1件含まれるが、これはAstro 6.4.6～6.4.8の各stable release自身が正確に指定するtransitive dependencyである。stable版へ強制するoverrideは指示どおり追加していない。

## Migration changes

変更は次の最小範囲に限定した。

1. `astro.config.mjs`のadapter importを、adapter 10で廃止された`@astrojs/vercel/serverless`からroot exportへ変更した。
2. `src/pages/blog/[...slug].astro`へ`export const prerender = true`を追加した。既存の`getStaticPaths()`をAstro 6で明示的に有効化し、MDX記事の`Astro.props`欠落による500を防ぐためである。
3. `tests/vercelPathOverrideRegression.test.mjs`を追加した。

Content Collectionsは既に`src/content.config.ts`、`astro/loaders`、`getCollection()`、`render()`を使用しており、legacy flagは不要だった。独自middleware、Astro session、custom adapter API、custom Vite/Rollup設定は存在せず、追加していない。

## Path override verification

### Installed source and generated artifact

adapter 10.0.8のserverless entrypointと生成済み`.vercel/output`を確認した。`x-astro-path` / `x_astro_path`という文字列自体は内部routing用として残るが、path採用には次の境界がある。

- `x-astro-path`: build時に生成されたmiddleware secretの完全一致が必要
- `x_astro_path`: Vercel ISR内部requestを示す`x-vercel-isr: 1`の場合だけ参照
- 未認証の通常requestでは`realPath`へ採用されない

したがって、単なる文字列検索ではなく生成handlerの実動作で確認した。

### Permanent dynamic regression

`tests/vercelPathOverrideRegression.test.mjs`は、Git管理外の一時directoryへ最小Astro SSR fixtureを作り、adapter 10で生成したhandlerの`fetch()`をin-processで呼ぶ。外部network、credential、実データ、production URLは使わず、終了時にfixtureを削除する。

確認ケース:

- `GET /route-a?x_astro_path=/route-b`
- `GET /route-a` + `x-astro-path: /route-b`
- `POST /route-a?x_astro_path=/route-b`
- `POST /route-a` + `x-astro-path: /route-b`

全4ケースでstatus 200、method保持、markerは`route-a`のまま、`route-b`へ到達しなかった。同fixtureの意図的error routeはstatus 500となり、例外本文をresponseへ出さなかった。

実サイト生成handlerでも、存在しないrouteへ同header/queryを与えてstatus 404のままであることを確認した。

## Framework and content regression

Node.js `22.23.1`で確認した。

| 対象 | 結果 |
|---|---|
| public SSR | `/`, `/types`, `/diagnosis`, `/compat`, `/contact`, `/terms`, `/privacy` は200 |
| auth/protected shell | `/login`, `/signup`, `/members`, `/history`, `/result` は200。実token・実account不使用 |
| API route | `/today.json`の入力不足は既存どおりJSON 400 |
| 404 | 未存在routeは404。header/query追加でも404 |
| 500 | 一時fixtureだけで500、stack/fixture error本文はresponseへ非公開 |
| MDX | `/blog/using-mdx/index.html`をprerender。titleと埋込みcomponent markerを確認 |
| RSS | `/rss.xml`は200、`application/xml`、XML parse成功、5 items |
| sitemap | indexと`sitemap-0.xml`生成、XML parse成功、17 URLs |
| sitemap exclusions | history/login/members/result/signup/checkout success/voice-processingは非掲載 |
| images | Sharp最適化6入力をbuildし、`_astro`へ12画像・341,549 bytes生成 |

認証関連画面は実利用者情報を使わず、HTML shellとclient-side auth導線の生成だけを確認した。実認証・redirectのクラウド動作はstaging確認へ残す。

## Tests and artifacts

- Node 22 full suite: 109 passed / 0 failed / 0 skipped（105 top-level testを含む）
- Astro 6 / Vercel build: PASS
- TypeScript: `typescript@5.9.3`を一時実行し`tsc --noEmit` PASS（dependency追加なし）
- reading engine / foundation / API handler build: PASS
- Node 22 artifact import: 3 artifacts PASS、AWS接続なし
- Python syntax: 12 files PASS（bytecode生成なし）
- Python/Node token互換、engine fixture parity、deep quota、idempotency、CORS、kill switch: full suite内でPASS
- `READING_DEEP_GENERATE_API_ENABLED`: 開始・検証時とも未設定

Artifact size:

| Artifact | Before | After | 差分 |
|---|---:|---:|---:|
| reading engine | 109,591 | 109,591 | 0 |
| reading foundation | 90,200 | 90,297 | +97 |
| reading API handler | 199,323 | 199,420 | +97 |
| `.vercel/output` | 376 files / 70,165,443 bytes | 530 files / 71,718,124 bytes | +154 files / +1,552,681 bytes |

Reading成果物の小差分は更新後のhoisted esbuildで再生成された結果であり、fixture parityと全handler testで意味上の回帰がないことを確認した。`.vercel/output`増加には5 blog routeの明示prerenderと最適化画像が含まれる。生成artifact全体はcommitしない。

## Dependency audit

| Severity | Before | After |
|---|---:|---:|
| critical | 1 | 0 |
| high | 10 | 4 |
| moderate | 4 | 1 |
| low | 1 | 3 |
| vulnerability node | 16 | 8 |

`GHSA-mr6q-rp88-fx84`は最終`npm audit --omit=dev --json`に存在せず、adapterはaffected range外である。

残存highは集約nodeを含む`@astrojs/vercel`、`@vercel/routing-utils`、`path-to-regexp`、`rollup`である。`path-to-regexp`は前回監査どおり現在のroute patternではadvisory成立条件を満たさない。Rollupはbuild-timeでありproduction runtimeへbundleされない。adapter/routing-utilsはこの2経路の集約findingである。新しい外部到達可能なcritical/highは確認されていないが、残存findingは別PRで再評価する。

RSS更新により、baselineの`fast-xml-parser` critical nodeは消えた。残存findingを本PRで一括修正せず、Astro 7 / adapter 11を必要とする提案も採用していない。

## Clean install

最初のworkspace内`npm ci`は、既に起動していた複数のAstro dev serverがesbuild binaryを保持していたためWindows `EPERM`で失敗した。プロセスを強制終了しなかった。

同じ`package.json`と`package-lock.json`だけをOS TEMPへ複製した隔離clean installを最終lockfileでも実行し、`npm ci`と`npm ls --omit=dev --all`が成功した。作業workspaceの依存はlockfileに従う`npm install`で復元した。最終review時にdev serverを人間が停止できる場合、workspace内`npm ci`の再実行をstaging前条件とする。

## Security and scope controls

- secret、token、実user、PIIをテスト・文書・差分へ追加していない。
- AWS、Vercel、production URLへ接続していない。
- Lambda、DynamoDB、IAM、課金、音声、reading engine sourceを変更していない。
- deploy、push、PR作成を行っていない。
- `READING_DEEP_GENERATE_API_ENABLED`を設定していない。

## Rollback

本変更はdependency、lockfile、adapter import、blog prerender、回帰test、文書を単一commitへまとめる。rollbackはそのcommitを通常の`git revert <commit>`で戻す。環境変数、DB、AWS、Vercel設定のrollbackは不要である。`reset --hard`やforce pushは使用しない。

## Staging conditions and remaining work

production deployは引き続き行わない。次工程の限定staging前に次を満たす。

1. 起動中dev serverを人間の判断で停止後、workspace内`npm ci`を再確認する。
2. Vercel Linux buildでSharp optional binaryと生成artifactを確認する。
3. preview URLでheader/query 4ケース、主要SSR、login/signup、members/history/result、RSS、sitemap、image、404/500を再確認する。
4. 残存highのRollupとpath-to-regexpを独立PRで再監査する。
5. production依存監査文書PRをmainへ統合し、本remediation結果でmatrix statusを更新する。

Astro 7 / adapter 11は、このAstro 6基盤をstaging確認した後の別計画とする。
