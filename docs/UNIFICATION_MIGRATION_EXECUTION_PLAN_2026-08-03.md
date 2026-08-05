# Unification Migration Execution Plan

Date: 2026-08-03

No step below is authorized by this document. Each PR must preserve a closed
paid runtime until its own exit gate passes.

| PR | Purpose | Candidate scope | Dependency | Required proof | Rollback | AWS / production impact |
|---|---|---|---|---|---|---|
| 1 | Freeze canonical membership/quota contracts | shared schemas, normalizers, period rules, contract tests | human period decisions | legacy/current fixtures classify deterministically | revert contract commit | none |
| 2 | Generate one environment-parameterized IaC topology | reading, membership, quota, ledger, webhook resources | PR1; canonical account decision | synth/validate and least-privilege tests | remove unapplied change set | AWS later; no prod yet |
| 3 | Build read-only migration inventory and dry-run tooling | Users/History schema mapper, collision report, rollback manifest | PR1-2; item-read approval later | zero-write dry run and reversible manifest | discard dry-run output | read-only first |
| 4 | Bind Reading runtime to canonical contracts | request/status/workers, canonical Users/History/quota | PR1-3 | Mock light/deep lifecycle and failure recovery | switches false; restore old binding | staging first |
| 5 | Replace Voice quota/ledger lifecycle | reserve/complete/release, atomic user/ledger/history behavior | PR1-4 | duplicate/concurrency/failure tests | Voice remains closed; legacy untouched | staging first |
| 6 | Add shared payment application service and Mock adapter | provider port, purchase intent, verified-event orchestration | PR1, PR5 | complete Mock gate in companion document | adapter disabled | none |
| 7 | Connect fincode TEST adapter and webhook | TEST credentials boundary, signature verification, period source | PR6 | browser 3DS plus verified-webhook E2E | TEST flags off | staging TEST only |
| 8 | Replace frontend endpoint/auth wiring | members, premium, checkout and paid-entry routes | PR4-7 | no `zaebx82pyf`; Bearer boundary E2E | feature flags/route rollback | public code, paid closed |
| 9 | Perform approved production migration/cutover | canonical stack, data migration, endpoint switch | all prior PRs and human GO | counts/hashes, dual-read comparison, rollback rehearsal | restore endpoint and manifest-backed data | production change |
| 10 | Retire legacy billing/runtime resources | old Stripe API and replaced Voice/membership paths | stable observation window | no traffic/dependency; archive evidence | retain before deletion window | destructive; separate approval |

## Ordered human gates

1. Select `PRODUCTION_CANONICAL_ACCOUNT`.
2. Decide whether legacy Users/History are migrated (recommended: YES).
3. Select new atomic Voice model or explicitly preserve the legacy model.
4. Fix Light and Deep quota periods from product contract.
5. Approve schema-only inventory and later item-level dry-run separately.
6. Approve staging deployment only after Mock proof.
7. Approve production cutover only after TEST E2E and rollback rehearsal.

## Cutover invariants

- no dual writable source of truth;
- no client-provided identity for entitlement decisions;
- no entitlement grant from browser callback alone;
- no partial Users/ledger/quota/history success;
- legacy data remains recoverable until the observation window closes;
- all paid switches default closed through migration.
