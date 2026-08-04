# Billing, membership, and paid-reading problem inventory

Date: 2026-08-03

Status: `PROBLEM_INVENTORY_COMPLETE_WITH_RUNTIME_RECHECK_PENDING`

Scope: repository, local IaC, saved deployed-template evidence, and read-only AWS
attempt. No application, database, AWS, fincode, production, or staging state
was changed.

## Evidence boundary

- Repository HEAD during the audit: `c1486eaefe95e0356cffea3dfe6e864129edf51d`
  on `feat/fincode-test-payment-e2e`.
- Tracked and staged changes were absent at the start. The six existing
  untracked deployment artifacts were not modified, deleted, or staged.
- A read-only AWS refresh was attempted with the approved `shirone-staging`
  profile in `ap-northeast-1`. The SSO token was expired, so no current runtime
  value was obtained. No AWS mutation was attempted.
- Runtime statements below distinguish three evidence levels:
  - `SOURCE`: current tracked code or IaC.
  - `SAVED_RUNTIME_EVIDENCE`: the existing untracked deployed-template snapshot.
  - `HUMAN_CONFIRMED`: the symptoms and current state supplied in the audit
    instruction.

## Result

| Severity | Count |
| --- | ---: |
| P0 | 4 |
| P1 | 7 |
| P2 | 5 |
| P3 | 5 |
| **Total** | **21** |

## Inventory

### BILL-P0-01: membership and reading runtime are split across AWS accounts

- Severity: P0
- Symptom: the existing site can show a premium record, while the new reading
  request/status/workers use a separate staging `ReadingUsersTable`.
- Expected: one authenticated identity resolves to one authoritative membership
  record and its matching quota/history stores.
- Actual: site pages contain hard-coded legacy API hosts and legacy Lambda
  defaults use `shirone7_users` / `shirone7_history`; the new IaC creates its own
  `ReadingUsersTable`, `ReadingHistoryTable`, Light/Deep quota tables and jobs.
- Root cause: no migration/replication contract, cross-account bridge, or
  authoritative cutover is implemented. IaC contains only Lambda service trust;
  no cross-account `AssumeRole` path exists.
- Evidence: `src/pages/members.astro:1456`, `src/pages/history/index.astro:860`,
  `lambda/login.py:95`, `lambda/voice_upload.py:26`,
  `infrastructure/reading-staging/template.json:43`.
- Affected AWS resources: legacy Users/History APIs and the staging logical
  resources `ReadingUsersTable`, `ReadingHistoryTable`, request/status/workers.
- Fix scope: architecture decision, identity migration, data migration and
  staged cutover.
- Safe to fix locally: no.
- Requires AWS: yes.
- Requires migration: yes.
- Requires production decision: yes.

### BILL-P0-02: members status UI does not use the new Bearer-token trust boundary

- Severity: P0
- Symptom: the members page derives `user_id` from browser storage and sends it
  as a query parameter to a legacy status endpoint.
- Expected: server-resolved identity from a verified Bearer token; client
  `user_id` must never decide record ownership.
- Actual: `fetch(USER_STATUS_API + ?user_id=...)` contains no Authorization
  header. The corresponding endpoint implementation is not in this repository,
  so ownership enforcement cannot be proven here.
- Root cause: the members UI predates `src/server/users/membershipContext.ts`.
- Evidence: `src/pages/members.astro:1456-1465`,
  `src/pages/members.astro:1875-1896`,
  `src/server/readingApi/readingApiService.ts:17-32`.
- Affected AWS resource: legacy user-status API/Lambda, exact implementation
  unverified.
- Fix scope: authenticated membership-status endpoint and UI migration.
- Safe to fix locally: partially, after the target API contract is chosen.
- Requires AWS: yes.
- Requires migration: no.
- Requires production decision: yes.

### BILL-P0-03: legacy voice quota check and consumption are not atomic

- Severity: P0
- Symptom: upload admission reads quota, then uploads to S3, starts Transcribe,
  and writes history without reserving a credit. Another Lambda later decrements
  a counter and silently skips a failed decrement.
- Expected: reserve before accepting work; complete or release atomically;
  concurrent requests cannot exceed entitlement.
- Actual: `check_voice_quota()` is a read-only check. It does not require an
  active subscription for monthly quota. `consume_voice_quota()` performs a
  later independent update and catches AWS errors without failing the result.
- Root cause: legacy uploaded-voice implementation predates the quota state
  machines used by paid text readings.
- Evidence: `lambda/voice_upload.py:257-283`,
  `lambda/voice_upload.py:376-470`, `lambda/lambda_function.py:286-323`.
- Affected AWS resources: legacy Users, History, voice bucket and Transcribe.
- Fix scope: voice request ledger, atomic reserve/complete/release and active
  membership condition.
- Safe to fix locally: design and tests only.
- Requires AWS: yes.
- Requires migration: possibly for in-flight/history records.
- Requires production decision: yes.

### BILL-P0-04: one-time voice grant cannot be atomic until table placement is fixed

- Severity: P0
- Symptom: the local `voice_single` adapter requires Purchase Ledger and Users
  in one DynamoDB transaction, while the authoritative Users account is not
  decided.
- Expected: purchase intent, verified capture ledger completion and
  `extra_voice_remaining +1` occur in one account and region.
- Actual: the adapter is local-only; no table, IAM, Lambda, route or Webhook is
  deployed. Cross-account DynamoDB transactions are not the design.
- Root cause: account-boundary decision has not preceded deployment design.
- Evidence: `src/server/fincode/oneTimeVoicePurchase.ts`,
  `src/server/fincode/aws/dynamoOneTimeVoiceGrant.ts`,
  `docs/FINCODE_ONE_TIME_VOICE_GRANT_LOCAL_IMPLEMENTATION_2026-08-03.md`.
- Affected AWS resources: future Purchase Ledger and authoritative Users table.
- Fix scope: decide Users authority, then same-account IaC and staging E2E.
- Safe to fix locally: no further than adapter/IaC design.
- Requires AWS: yes.
- Requires migration: depends on the Users decision.
- Requires production decision: yes.

### BILL-P1-01: premium users cannot start Light reading from the Light page

- Severity: P1
- Symptom: `/premium/light` always displays billing-review copy and pricing CTA.
- Expected: active Light/Premium users see an authenticated reading form and
  submit to the new request API.
- Actual: the page imports only catalog data; it has no auth, membership fetch,
  request submission, job polling or result navigation.
- Root cause: storefront page was never connected to the implemented server
  foundation.
- Evidence: `src/pages/premium/light.astro:1-103`.
- Affected AWS resource: future reading request/status API integration.
- Fix scope: frontend integration.
- Safe to fix locally: yes after endpoint/environment contract is fixed.
- Requires AWS: staging E2E yes.
- Requires migration: no.
- Requires production decision: endpoint cutover yes.

### BILL-P1-02: Deep backend exists but the user path is deliberately closed

- Severity: P1
- Symptom: members and `/premium/deep` show “準備中”.
- Expected: an entitled Premium user can explicitly select Deep, reserve one of
  three JST-calendar-month uses, poll, and read the result/history.
- Actual: source contains mode resolution, quota 3, request/status, async worker,
  history, failure release and tests. The pages contain no execution UI and the
  staging switches/workers are human-confirmed off.
- Root cause: backend foundation and storefront were delivered in separate
  phases and have not been connected/opened.
- Evidence: `src/pages/members.astro:1330-1334`,
  `src/pages/premium/deep.astro:87-101`,
  `src/server/readingPersistence/deepQuota.ts:4`,
  `tests/readingDeepQuota.test.mjs`.
- Affected AWS resources: request/status, Deep worker/queue/quota/history.
- Fix scope: staged enablement and UI polling integration.
- Safe to fix locally: UI and contract tests only.
- Requires AWS: yes.
- Requires migration: authoritative user must exist in staging.
- Requires production decision: yes.

### BILL-P1-03: Voice balance is shown but no usable Voice workflow is exposed

- Severity: P1
- Symptom: members shows a balance, but there is no “use voice” doorway; the
  Voice page is a pricing/preparation page.
- Expected: entitled user can start the intended Voice product and see status,
  result and history.
- Actual: `/premium/voice` has no upload or TTS form. Existing history links
  point there, but it only links to pricing/history.
- Root cause: uploaded-voice consultation, future TTS voice, and 300-yen credit
  have not been reconciled into one public product contract.
- Evidence: `src/pages/premium/voice.astro:55-83`,
  `src/pages/members.astro:1304-1369`,
  `docs/voice-upload-and-tts-boundary.md:93-163`.
- Affected AWS resources: undecided; legacy voice stack and/or future TTS stack.
- Fix scope: product decision followed by one safe execution path.
- Safe to fix locally: CTA only is unsafe until the backend choice is made.
- Requires AWS: yes.
- Requires migration: possibly.
- Requires production decision: yes.

### BILL-P1-04: paid reading runtime remains closed by safety switches

- Severity: P1
- Symptom: request/status routes reach their Lambdas but paid processing cannot
  run; workers do not poll.
- Expected: staged, explicitly approved enablement order.
- Actual: human-confirmed state has kill switches false, ESM disabled and
  Bedrock false. IaC defaults all related switches to false.
- Root cause: correct fail-closed deployment posture; E2E graduation has not
  been completed.
- Evidence: `infrastructure/reading-staging/template.json:16-23`,
  `infrastructure/reading-staging/template.json:388-418`, human confirmation.
- Affected AWS resources: request/status, Light/Deep ESM and workers.
- Fix scope: controlled staging Change Sets, not a source-code shortcut.
- Safe to fix locally: no.
- Requires AWS: yes.
- Requires migration: test identity first.
- Requires production decision: later.

### BILL-P1-05: direct fincode activation cannot resolve a trusted period

- Severity: P1
- Symptom: paid membership and Light quota cannot be activated by Webhook.
- Expected: official subscription period source provides canonical UTC start/end.
- Actual: no verified live provider period adapter exists; ACTIVE/RUNNING fails
  closed, and period/Webhook/Light-quota flags default off.
- Root cause: provider period API contract is unverified.
- Evidence: `docs/FINCODE_WEBHOOK_LAMBDA_IAC_INTEGRATION_2026-07-30.md:24-40`,
  `src/server/fincode/fincodeWebhookLambda.ts:59-70`.
- Affected AWS resources: Webhook Lambda, Users and Light quota.
- Fix scope: official contract, injected adapter, staging E2E.
- Safe to fix locally: adapter after official contract is obtained.
- Requires AWS: yes.
- Requires migration: yes for legacy paid records.
- Requires production decision: yes.

### BILL-P1-06: legacy Premium can look active while Light quota must reject it

- Severity: P1
- Symptom: a record with `plan=premium`, `active`, `deep_enabled=true` and empty
  period is shown as Premium, but cannot form a valid Light quota snapshot.
- Expected: paid membership v1 requires schema/version/source and a valid period
  pair before any paid entitlement is exposed.
- Actual: `loadAuthenticatedMembershipContext()` uses lenient
  `getMembershipEntitlements()` and never calls the strict v1 parser. Light
  acceptance later converts missing period/version to empty/NaN and fails closed.
- Root cause: legacy-compatible display entitlement and strict billing
  membership are two different validators without an explicit boundary state.
- Evidence: `src/server/users/membershipContext.ts:8-17`,
  `src/lib/membershipEntitlements.ts:42-69`,
  `src/server/fincode/membershipSchema.ts:36-60`,
  `src/server/readingApi/readingApiService.ts:71-77`.
- Affected AWS resources: authoritative Users and Light quota.
- Fix scope: explicit legacy classification and migration gate.
- Safe to fix locally: validator/tests yes.
- Requires AWS: migration validation yes.
- Requires migration: yes.
- Requires production decision: yes.

### BILL-P1-07: local fincode/Light-quota IaC is ahead of saved deployed runtime

- Severity: P1
- Symptom: local template contains 43 resources including Webhook and Light
  quota, while the saved deployed-template snapshot has 32 and lacks
  `FincodeLightQuotaTable`.
- Expected: living source and runtime deployment status are explicitly tracked.
- Actual: source implementation is deploy-ready only at a local level; saved
  runtime evidence represents the earlier reading stack.
- Root cause: local fincode integration has not been deployed.
- Evidence: local JSON structural comparison performed in this audit;
  `infrastructure/reading-staging/template.json:161-179` and the preserved
  `reading-staging-deployed-template.json` snapshot.
- Affected AWS resources: future Webhook, mapping, ledger and Light quota.
- Fix scope: reviewed Change Set after period/account decisions.
- Safe to fix locally: documentation only.
- Requires AWS: yes.
- Requires migration: yes.
- Requires production decision: no for staging, yes for production.

### BILL-P2-01: human-edited Premium Voice values violate the catalog policy

- Severity: P2
- Symptom: test display shows 20 monthly and 20 extra credits.
- Expected: Premium monthly Voice is 10; extra credit represents verified
  one-time purchases only.
- Actual: human-confirmed record was manually set to 20/0/20 for display.
- Root cause: test fixture data bypassed membership v1 and purchase ledger.
- Evidence: human confirmation; `src/lib/billingPlans.ts:48-59`,
  `src/server/fincode/membershipSchema.ts:56-60`.
- Fix scope: staging-only dry-run migration after account authority is decided.
- Safe to fix locally: migration planner only.
- Requires AWS: yes.
- Requires migration: yes.
- Requires production decision: no for the test record.

### BILL-P2-02: quota constants are duplicated across catalog and execution code

- Severity: P2
- Symptom: 5/20 Light, 3 Deep and 3/10 Voice appear in multiple modules.
- Expected: one reviewed plan policy feeds display, membership writer and quota
  validators, or an explicit generated consistency contract prevents drift.
- Actual: values currently agree but are independently hard-coded.
- Root cause: storefront and server foundations evolved independently.
- Evidence: `src/lib/billingPlans.ts:34-59`,
  `src/server/readingPersistence/lightQuota.ts:5-7`,
  `src/server/readingPersistence/deepQuota.ts:4`,
  `src/server/fincode/membershipSchema.ts:56-60`.
- Fix scope: shared policy artifact or cross-layer invariant tests.
- Safe to fix locally: yes.
- Requires AWS: no.
- Requires migration: no.
- Requires production decision: no.

### BILL-P2-03: “Voice” names two incompatible products and quota meanings

- Severity: P2
- Symptom: UI balance can be read as access to uploaded-voice consultation or
  generated TTS, though design documents explicitly separate them.
- Expected: product, quota, history type and CTA name uniquely identify the
  experience.
- Actual: legacy `history.type=voice`, `premium_voice`, users monthly counters,
  future TTS usage and `voice_single` are adjacent but not unified.
- Root cause: product naming preceded the responsibility split.
- Evidence: `docs/voice-upload-and-tts-boundary.md:93-163`,
  `docs/voice-credit-usage-design.md:89-128`.
- Fix scope: product/usage schema decision before UI opening.
- Safe to fix locally: documentation and names after decision.
- Requires AWS: eventual migration.
- Requires migration: likely.
- Requires production decision: yes.

### BILL-P2-04: completed-history source is split between legacy and new stores

- Severity: P2
- Symptom: old pages read a legacy History API/table while the new status API
  reads `ReadingHistoryTable` as its result source of truth.
- Expected: one history ownership/read contract or an explicit federated view.
- Actual: old history pages use a hard-coded `/prod` API; new workers write the
  new reading history schema. Voice history uses the old table and S3 fields.
- Root cause: server migration is not connected to the existing history UI.
- Evidence: `src/pages/history/index.astro:860`,
  `src/server/readingStatus/dynamoReadingStatusRepository.ts`,
  `lambda/voice_upload.py:302-326`.
- Fix scope: history migration/federation and stable public schema.
- Safe to fix locally: design/tests only.
- Requires AWS: yes.
- Requires migration: yes.
- Requires production decision: yes.

### BILL-P2-05: no unified membership and quota status response exists

- Severity: P2
- Symptom: members displays Users voice counters but cannot display Light/Deep
  reserved/used/remaining from their dedicated tables.
- Expected: authenticated aggregation of membership plus per-mode quota, with
  source labels and safe unavailable states.
- Actual: legacy `/user/status` returns user fields; new `/reading/status` is a
  job polling API and intentionally does not aggregate membership.
- Root cause: membership status and async job status have different purposes,
  and no facade was added.
- Evidence: `src/pages/members.astro:1889-1929`,
  `src/server/readingStatus/readingStatusService.ts`.
- Fix scope: new authenticated membership/quota query service.
- Safe to fix locally: API contract and tests yes.
- Requires AWS: yes.
- Requires migration: no after authoritative tables are chosen.
- Requires production decision: yes.

### BILL-P3-01: `normal`, `member`, and `light` remain mixed plan identifiers

- Severity: P3
- Symptom: UI normalizes current Light to `normal`, while the new server uses
  `light`.
- Expected: canonical `free|light|premium` outside a bounded legacy adapter.
- Actual: members plan cards/change-plan still emit `normal`; normalization
  accepts `normal` and `member` in shared code.
- Root cause: historical plan naming.
- Evidence: `src/pages/members.astro:1473-1493`,
  `src/pages/members.astro:1659-1779`, `src/lib/membership.ts:30-42`.
- Fix scope: bounded legacy adapter and UI canonicalization.
- Safe to fix locally: yes after old API contract is inventoried.
- Requires AWS: possibly old API compatibility.
- Requires migration: maybe.
- Requires production decision: no.

### BILL-P3-02: `deep_enabled` is current policy but looks like a legacy switch

- Severity: P3
- Symptom: human and code reviews may treat it as obsolete because plan already
  says Premium.
- Expected: documented role as a master gate distinct from Deep count.
- Actual: it remains required by membership v1, mode resolution and DynamoDB
  condition checks. Manual records can still set it without schema proof.
- Root cause: field name does not express its current role and legacy records
  share the same field.
- Evidence: `src/server/fincode/membershipSchema.ts:56-60`,
  `src/server/readingPersistence/dynamoReadingPersistence.ts:287-304`,
  `docs/READING_DEEP_MONTHLY_QUOTA.md:5`.
- Fix scope: documentation, schema classification and migration checks.
- Safe to fix locally: yes.
- Requires AWS: migration validation.
- Requires migration: yes for legacy records.
- Requires production decision: no.

### BILL-P3-03: Stripe-era attributes remain in data but not in new entitlement code

- Severity: P3
- Symptom: legacy records contain `stripe_*` identifiers.
- Expected: dead fields are ignored, documented and removed only by an audited
  migration.
- Actual: new repositories whitelist fields and tests prove Stripe-only data
  grants no entitlement. The legacy status/change-plan endpoint implementation
  is absent, so its behavior cannot be proved from this repo.
- Root cause: incomplete provider migration.
- Evidence: `src/server/users/dynamoUserRepository.ts:7-42`,
  `tests/membershipEntitlements.test.mjs:82-93`,
  `tests/readingModeResolution.test.mjs:100-118`.
- Fix scope: legacy endpoint audit then migration plan.
- Safe to fix locally: no deletion.
- Requires AWS: inventory yes.
- Requires migration: eventually.
- Requires production decision: yes.

### BILL-P3-04: active members still receive billing-review messaging as primary content

- Severity: P3
- Symptom: when billing is globally disabled, `renderPlanCards()` returns only
  the billing-review banner for every membership tier.
- Expected: active users see usable entitlements first; billing review is a
  secondary notice.
- Actual: the banner is visually compact after `428e2b4`, but the branch occurs
  before plan-specific rendering.
- Root cause: global storefront flag and entitlement UX share one rendering
  container.
- Evidence: `src/pages/members.astro:1639-1729`.
- Fix scope: separate “use current entitlement” from “buy/change plan”.
- Safe to fix locally: yes after functional CTAs exist.
- Requires AWS: no for layout; yes for live behavior.
- Requires migration: no.
- Requires production decision: no.

### BILL-P3-05: frontend API endpoints are embedded in several pages

- Severity: P3
- Symptom: auth, membership and history pages point to multiple hard-coded API
  hosts/stages.
- Expected: environment-specific public configuration with explicit ownership.
- Actual: members, login/signup and history each contain fixed URLs, including
  a `/prod` history base.
- Root cause: incremental Lambda/API deployment history.
- Evidence: `src/pages/members.astro:1456-1457`,
  `src/pages/login.astro:245`, `src/pages/history/index.astro:860`.
- Fix scope: endpoint inventory and environment configuration.
- Safe to fix locally: only after target APIs are selected.
- Requires AWS: yes.
- Requires migration: no.
- Requires production decision: yes.

## Top 10 critical issues

1. Cross-account Users/history/reading split (`BILL-P0-01`).
2. Legacy members status trust boundary (`BILL-P0-02`).
3. Non-atomic legacy voice quota (`BILL-P0-03`).
4. Undecided same-account placement for one-time Voice grant (`BILL-P0-04`).
5. Premium Light UI not connected (`BILL-P1-01`).
6. Deep implementation closed at UI/runtime flags (`BILL-P1-02`).
7. Voice has no selected safe product path (`BILL-P1-03`).
8. Paid reading workers and Bedrock remain disabled (`BILL-P1-04`).
9. Trusted subscription period source is unavailable (`BILL-P1-05`).
10. Legacy Premium display and strict Light quota disagree (`BILL-P1-06`).

## Source-of-truth conclusion

- Premium membership source of truth: **not yet singular**. Membership v1 is the
  intended strict source, but the live site still consumes legacy Users fields.
- Light source of truth: dedicated per-period `FincodeLightQuotaTable`, limit
  5/20, bound to membership version and canonical period.
- Deep source of truth: dedicated JST-month `ReadingDeepQuotaTable`, limit 3;
  Users `deep_enabled` is only the master gate.
- Voice source of truth: current monthly/extra counters are Users fields, but
  the legacy consumption implementation is not safe enough to be the final
  execution source. The future one-time grant ledger is local-only.

## Current usability answer

- Can Premium use Light today? **No through the current site flow.** Backend
  source supports Premium→Light, but UI, strict period/quota record and runtime
  switches are not connected.
- Can Premium use Deep today? **No through the current site flow.** Backend is
  implemented and tested, but UI and staging execution remain closed.
- Can Premium use Voice today? **No supported public path.** A legacy backend
  exists, but the page is closed and its quota lifecycle is unsafe.

## Action boundary

- Safe local fixes: UI entitlement/storefront separation, canonical plan names,
  strict membership classification, shared policy invariant tests.
- Requires AWS staging: identity migration, membership/quota facade, workers,
  period source, Webhook, Voice lifecycle and E2E.
- Requires data migration: legacy paid membership, invalid Voice test values,
  Users/history authority and likely Voice request state.
- Requires architecture decision: authoritative AWS account, history strategy,
  Voice product definition and production API cutover.

## Local verification

- `npm test`: 281 passed, 0 failed, 0 skipped.
- `npm run build`: PASS (Astro server/Vercel build completed).
- TypeScript 5.9.3 `tsc --noEmit`: FAIL with 7 existing source errors in the
  fincode membership/retention types and Light quota error-code types. The
  audit Markdown files do not participate in those errors.
- `git diff --check`: PASS.
- Secret and email pattern scan across the four audit documents: no matches.
- Current AWS runtime refresh: not completed because the approved staging SSO
  session had expired. No AWS call progressed beyond failed authentication and
  no AWS mutation occurred.

## Final summary

```text
PROBLEM INVENTORY RESULT

Total issues: 21
P0: 4
P1: 7
P2: 5
P3: 5

Premium membership source-of-truth: unresolved legacy Users vs membership v1
Light source-of-truth: dedicated period quota, not Users counters
Deep source-of-truth: dedicated JST-month quota plus deep_enabled master gate
Voice source-of-truth: Users counters today; final safe execution model unresolved

AWS account boundary: split; no bridge/cutover contract
Legacy dependencies: user/status, history, voice upload, normal plan aliases
Runtime/IaC drift: local fincode IaC ahead of saved deployed snapshot
Frontend/backend drift: material
Missing tests: material

Can Premium use Light today?: No supported end-to-end path
Can Premium use Deep today?: No supported end-to-end path
Can Premium use Voice today?: No supported end-to-end path

Mutation performed: 0
Deploy performed: 0
Push/PR performed: 0

Final verdict: BLOCKED_BY_CROSS_ACCOUNT_ARCHITECTURE
```
