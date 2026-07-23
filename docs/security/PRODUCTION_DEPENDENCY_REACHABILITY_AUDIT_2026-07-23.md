# Production依存脆弱性・差分到達可能性監査（2026-07-23）

## 結論

```text
DEPENDENCY_SECURITY_GATE: PRODUCTION_DEPENDENCY_GATE_CONDITIONAL_PASS
LIMITED_PAID_BETA_GATE: DEPENDENCY_FIX_REQUIRED_BEFORE_START
AUTOMATED_MOSH_ENTITLEMENT_GATE: NOT_IMPLEMENTED
DEEP_PUBLIC_GATE: DISABLED
```

criticalは0件、外部または認証済み入力から到達可能なhighは0件、critical/highの`UNKNOWN`は0件だった。ただし、highの`sharp`と`path-to-regexp`がVercel SSR artifactに含まれ、修正版も存在する。成立条件は現在満たさないものの、有料β開始前に最小依存更新を別PRで行う条件付き合格とする。

本監査は依存関係を変更していない。AWS、Vercel、MOSH、fincode、productionへの接続や操作も行っていない。`READING_DEEP_GENERATE_API_ENABLED`は未設定のままである。

## 監査基準

- branch: `audit/production-dependency-reachability-delta`
- baseline commit: `bc65df082fc569a02692b5b5021a29fed6d668d5`
- baseline: PR #85 merge済み、`HEAD === origin/main`、開始時clean
- Astro: `6.4.8`
- `@astrojs/vercel`: `10.0.8`
- raw evidence: `docs/security/evidence/npm-audit-production-2026-07-23.json`

## Audit snapshot

| 指標 | PR #84直後 | 2026-07-23 | 差分 |
|---|---:|---:|---:|
| total vulnerable node | 8 | 9 | +1 |
| critical | 0 | 0 | 0 |
| high | 4 | 6 | +2 |
| moderate | 1 | 2 | +1 |
| low | 3 | 1 | -2 |

現在値は「9個のCVE」を意味しない。`npm audit`が報告する脆弱package nodeは9、unique packageも9、実advisoryは8件である。直接依存は4 package、推移依存は5 packageだった。`@astrojs/vercel`、`@vercel/routing-utils`、`@astrojs/mdx`は依存先findingを集約したnodeで、独立したadvisoryではない。

## 8件から9件へ変化した理由

PR #84のAstro 6更新commit `07ed47e`から現在HEADまで、`package.json`と`package-lock.json`に差分はない。PR #85も依存を変更していない。

一方、現在追加認識されているAstroの3件は2026-07-17公開・7月20日更新、sharpの1件は7月17日公開・7月21日更新である。したがって今回の差分は、新しい依存の混入ではなく、同一lockfileに対するregistry/advisory metadataの更新と、それを受けた集約nodeの重大度再計算によるものと判断した。

## Advisory別判定

| package / advisory | severity | surface | 到達可能性 | blocker | 対応 |
|---|---|---|---|---|---|
| Astro / GHSA-4g3v-8h47-v7g6 | moderate | Vercel SSR | `INCLUDED_NOT_REACHABLE` | いいえ | 期限付き更新 |
| Astro / GHSA-f48w-9m4c-m7f5 | moderate | Vercel SSR | `INCLUDED_NOT_REACHABLE` | いいえ | 期限付き更新 |
| Astro / GHSA-7pw4-f3q4-r2p2 | low | Vercel SSR | `INCLUDED_NOT_REACHABLE` | いいえ | 期限付き更新 |
| sharp / GHSA-f88m-g3jw-g9cj | high | Vercel SSR・build | `INCLUDED_NOT_REACHABLE` | β前更新条件 | `FIX_BEFORE_PAID_BETA` |
| path-to-regexp / GHSA-9wv6-86v2-598j | high | Vercel SSR | `INCLUDED_NOT_REACHABLE` | β前更新条件 | `FIX_BEFORE_PAID_BETA` |
| Rollup / GHSA-mw96-cpmx-2vgc | high | build | `BUILD_TIME_ONLY` | β前更新条件 | `FIX_BEFORE_PAID_BETA` |
| mdast-util-to-hast / GHSA-4fh9-h7wg-q85m | moderate | MDX build | `BUILD_TIME_ONLY` | いいえ | 期限付き更新 |
| esbuild / GHSA-g7r4-m6w7-qqqr | low | local | `LOCAL_ONLY` | いいえ | 期限付き更新 |

完全な機械可読行は`PRODUCTION_DEPENDENCY_REACHABILITY_MATRIX_2026-07-23.json`に記録した。

### Astro XSS 3件

`GHSA-4g3v-8h47-v7g6`は、攻撃者入力をView Transition animation propertyへ渡すことが前提である。`src/`には`transition:animate`がなく、request-derived値をtransition APIへ渡す経路もない。

`GHSA-f48w-9m4c-m7f5`は、SSR環境にglobal `HTMLElement`があり、native `HTMLElement` subclassへ攻撃者制御のspread keyを渡すことが前提である。Vercel Node SSRではこの分岐条件を満たさず、該当componentもない。

`GHSA-7pw4-f3q4-r2p2`は、`client:*` hydrated componentの`transition:persist`、`transition:scope`、`transition:persist-props`へ攻撃者入力を渡すことが前提である。該当directiveも`client:*` componentもない。

### sharp high

Vercel生成物は`/_image`を`_render`へ割り当て、`sharp` chunk、package、native binaryを含む。したがって「runtimeにない」とは判定していない。

ただしadvisoryの成立には、攻撃者が用意した画像をsharp/libvipsへ処理させる必要がある。現在のAstro image設定は`domains: []`、`remotePatterns: []`で、remote URLはendpoint内で403となる。画像upload APIもなく、buildで最適化された6画像はrepository管理の固定assetである。`/_image`のqueryで選択できるsame-origin fileは攻撃者が新規作成できない。このため、脆弱処理はartifactに含まれload可能だが、悪性画像入力へは到達しない。

この境界が将来変わり、remote image domain、画像upload、利用者管理画像のいずれかを追加した場合、本判定は無効となり再監査が必要である。

### path-to-regexp high

脆弱な正規表現は、単一segment内に非ピリオド文字で区切られた2 parameter（例`/:a-:b`）がある場合に生成される。`.vercel/output/config.json`とAstro manifestの現在routeにはこの形がない。動的routeは`/history/[id]`と内部`/_server-islands/[name]`の単一parameterである。したがって任意URL pathはVercel SSRへ届くが、脆弱なpatternは生成されていない。

### Rollup high

攻撃者がRollup input名、chunk alias、pluginから`../`を含む出力名を制御することが前提である。Rollupはlocal/CI buildでrepositoryとoperatorが管理する入力を処理し、Vercel function、browser bundle、reading 3 artifactには含まれない。`BUILD_TIME_ONLY`とした。

### mdast-util-to-hast moderate

影響はuser-supplied Markdownのcode language classを通じる。白音七のMarkdown/MDXはrepository管理で、外部利用者からMarkdownを受け取る処理はない。blogはbuild時にprerenderされ、packageはSSR functionに含まれない。

### esbuild low

Windows上でesbuild自身のdevelopment serverを`servedir`付きで動かすことが前提である。白音七のscriptは`astro dev`であり、esbuild serveを起動しない。production artifactにも含まれない。

## Production surface

| surface | 判定 |
|---|---|
| Vercel Astro SSR | Astro runtime、adapter/routing-utils、path-to-regexp、sharpを確認。外部到達highは0。 |
| Vercel static/prerender | MDX、Markdown変換、Rollup、sharpはbuild時のみ。出力HTML/CSS/imageに脆弱package runtimeはない。 |
| Browser bundle | 監査対象9 packageのruntime code/importを確認せず。 |
| Reading engine | build/import可能。監査対象packageをbundleせず、runtime externalもなし。 |
| Reading foundation | build/import可能。監査対象packageをbundleせず、runtime externalもなし。 |
| Reading API handler | build/import可能。監査対象packageをbundleせず、runtime externalもなし。 |
| Local/test | esbuildとRollupを使用。外部production入力なし。 |

## Reachability集計

- externally reachable critical: 0
- externally reachable high: 0
- authenticated reachable high: 0
- operator/build-only high advisory: 1（Rollup）
- included but vulnerable precondition not reachable high nodes: 5（sharp、path-to-regexp、Astroとadapter/routing-utilsの3 aggregate node）
- unknown critical/high: 0

## 修正方針

本監査では更新していない。別PRで次の順序を推奨する。

1. `sharp`を0.35系の修正版へ最小更新し、build、`/_image`、Windows/Linux artifactを再検証する。
2. `path-to-regexp` 6.1.0を持つ`@vercel/routing-utils`経路について、compatibleなadapter patch/minorまたは安全なoverrideを単独検証する。Path Override 4ケースも再実測する。
3. Rollup 4.59.0以上、mdast-util-to-hast 13.2.1以上、esbuild 0.28.1以上へ解消できる最小graphを一つずつ検証する。
4. AstroのXSS修正版はAstro 7系であるため、上記patch系と分離し、Astro 7 / adapter互換性を独立計画にする。

`npm audit fix`、`--force`、一括major updateは行わない。

## MOSH / 有料β境界

```text
MOSH_INTEGRATION_MODE: MANUAL_RECONCILIATION
MOSH_WEBHOOK: NOT_IMPLEMENTED
MOSH_API: NOT_CONFIRMED
ENTITLEMENT_AUTO_GRANT: DISABLED
SELF_REPORTED_PURCHASE_GRANT: FORBIDDEN
EMAIL_MISMATCH_GRANT: FORBIDDEN
```

現在はMOSH購入を運営者が販売記録で確認し、白音七accountとの同一性を確認した場合だけ手動付与する。MOSHと白音七のメールが一致しても自動付与せず、不一致時も付与しない。自己申告だけの付与は禁止する。

少人数の有料β開始には、依存のβ前修正に加え、`SAFE_ADMIN_ENTITLEMENT_UPDATE`、`PURCHASE_LEDGER`、`DUPLICATE_GRANT_PREVENTION`、`REVOCATION_RUNBOOK`、`PAYMENT_FAILURE_RUNBOOK`、`RATE_LIMIT`、`STAGING_SMOKE`が必要である。自動販売にはさらにMOSH公式API/Webhook、購入識別子、replay防止、idempotency、取消・返金処理、監査証跡が必要である。

## 証拠と制約

- npm audit raw JSONはNode経由でUTF-8保存し、parseを確認した。
- package graphは`npm explain`で確認した。
- Astro buildから`.vercel/output`を再生成し、route、bundle、package inclusionを確認した。
- reading 3 artifactを再buildし、監査対象packageの非混入を確認した。
- advisoryの成立条件はGitHub Security Advisoryとpackage公式repositoryの記載を基準にした。
- production、Preview、AWS、MOSHへのHTTP/API接続は0件。
- 実利用者情報、購入情報、token、secret、request IDを証跡へ保存していない。

## 一次情報

- Astro View Transition animation XSS: https://github.com/advisories/GHSA-4g3v-8h47-v7g6 （公開2026-07-17、更新2026-07-20）
- Astro spread attribute name XSS: https://github.com/advisories/GHSA-f48w-9m4c-m7f5 （CVE-2026-59729、公開2026-07-17、更新2026-07-20）
- Astro hydrated island transition XSS: https://github.com/advisories/GHSA-7pw4-f3q4-r2p2 （CVE-2026-59727、公開2026-07-17、更新2026-07-20）
- sharp/libvips: https://github.com/advisories/GHSA-f88m-g3jw-g9cj （公開2026-07-17、更新2026-07-21）
- path-to-regexp: https://github.com/advisories/GHSA-9wv6-86v2-598j
- Rollup: https://github.com/advisories/GHSA-mw96-cpmx-2vgc
- mdast-util-to-hast: https://github.com/advisories/GHSA-4fh9-h7wg-q85m
- esbuild: https://github.com/advisories/GHSA-g7r4-m6w7-qqqr

## 検証結果

- Node.js 22.23.1: PASS
- `npm test`: PASS（119 tests / 0 fail / 0 skipped）
- `npm run build`: PASS
- TypeScript `tsc --noEmit`: PASS
- reading engine / foundation / API handler build: PASS
- reading 3 artifact Node.js 22 import: PASS
- reading 3 artifactへの監査対象package混入: 0
- `npm audit --omit=dev`: expected non-zero、9 vulnerabilities（critical 0 / high 6 / moderate 2 / low 1）を再確認
- raw audit JSON parse: PASS
- matrix JSON parse: PASS
- `git diff --check`: PASS
- 変更ファイル秘密情報pattern scan: PASS
- `READING_DEEP_GENERATE_API_ENABLED`: unset

## 次工程

有料βより先に「最小production依存修正PR」を実施する。dependency gate再確認後の次機能PRは`#87 会員別rate limit`とする。deep一般公開は引き続き無効である。
