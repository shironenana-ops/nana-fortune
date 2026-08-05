# Missing paid-membership test coverage

Date: 2026-08-03

The existing suite verifies many isolated server invariants. It did not detect
the human-visible failures because it does not exercise the complete page →
membership → quota → request → polling → history chain.

## Existing coverage that should be preserved

- Active Premium resolves to Light by default and Deep only when explicitly
  requested and enabled.
- Light quota limits are 5/20 with reserve/complete/release semantics.
- Deep quota is 3 with reserve/consume/release, replay and concurrency checks.
- Async request/status ownership, idempotency, Rate Limit and failure recovery.
- Membership v1 strict validation and Stripe attribute non-entitlement.
- Voice monthly/extra arithmetic in the shared entitlement helper.
- One-time Voice duplicate grant is idempotent in local adapter tests.

## Missing tests

### UI integration

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-01 | Active Premium visits `/premium/light` | authenticated reading form, not storefront CTA |
| TEST-GAP-02 | Active Premium submits Light | Bearer token + Idempotency-Key, 202 then polling |
| TEST-GAP-03 | Active Premium with Deep entitlement visits Deep | executable CTA only when runtime gate is enabled |
| TEST-GAP-04 | Active Premium with Voice 10/0 | one unambiguous Voice CTA and correct product label |
| TEST-GAP-05 | Billing globally disabled for active member | entitlement actions remain primary; purchase notice secondary |
| TEST-GAP-06 | `normal` legacy record | display compatibility without emitting `normal` to new APIs |

### Membership and status boundary

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-07 | Legacy Premium missing schema/period/version | classified `migration_required`, no paid execution |
| TEST-GAP-08 | Query `user_id` differs from Bearer identity | request denied without existence disclosure |
| TEST-GAP-09 | Membership status aggregate | membership plus Light/Deep/Voice source-labelled balances |
| TEST-GAP-10 | Missing quota table/item | safe unavailable state, not zero-as-authoritative |
| TEST-GAP-11 | Period ended but status still active | paid execution denied pending trusted renewal |
| TEST-GAP-12 | Stripe-only legacy fields | no plan/status/quota grant in every public status path |

### Cross-account and deployment contract

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-13 | Site identity absent from staging Users | explicit migration error, no fallback to free/legacy mutation |
| TEST-GAP-14 | frontend endpoint manifest | no hard-coded production/staging host in page modules |
| TEST-GAP-15 | deployed template vs source manifest | added/removed logical resources require release evidence |
| TEST-GAP-16 | Light/Deep workers disabled | UI cannot advertise executable paid action |
| TEST-GAP-17 | wrong-account Users table | startup/health gate fails closed |

### Light lifecycle

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-18 | Premium 20th Light request | accepted |
| TEST-GAP-19 | Premium 21st Light request | limit reached |
| TEST-GAP-20 | failed worker | reservation released, history failed, retry policy deterministic |
| TEST-GAP-21 | same Idempotency-Key same body | same job/result, no second quota use |
| TEST-GAP-22 | same key different body | conflict, no quota use |

### Deep lifecycle

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-23 | UI-to-API explicit Deep selection | exactly one of three uses reserved |
| TEST-GAP-24 | Deep worker/provider failure | reservation released, no completed history |
| TEST-GAP-25 | month boundary Asia/Tokyo | old period preserved; new period starts at zero |

### Voice lifecycle

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-26 | inactive plan with stale monthly limit | monthly Voice denied |
| TEST-GAP-27 | free/light with verified extra credit | exact intended Voice product allowed once |
| TEST-GAP-28 | two concurrent Voice starts with one credit | one accepted, one denied |
| TEST-GAP-29 | S3 succeeds, Transcribe fails | reservation released or explicit retry state |
| TEST-GAP-30 | result succeeds, quota transaction fails | result not published as consumed success |
| TEST-GAP-31 | same capture delivered ten times | `extra_voice_remaining` increases exactly once |
| TEST-GAP-32 | wrong amount/product/shop/environment | no purchase intent completion or grant |
| TEST-GAP-33 | monthly Voice then extra Voice | documented consume order with atomic ledger evidence |

### History

| ID | Test | Expected |
| --- | --- | --- |
| TEST-GAP-34 | new async result appears in user history | one canonical public representation |
| TEST-GAP-35 | legacy Voice history and new text history | federated/migrated behavior matches chosen architecture |
| TEST-GAP-36 | membership expires after completion | owner can still read completed purchased history |

## Recommended order

1. Add source-of-truth and cross-account boundary tests before UI work.
2. Add strict legacy membership classification and aggregate-status tests.
3. Add Premium Light end-to-end browser tests against a local injected API.
4. Add Deep integration tests using the same UI polling component.
5. Decide the Voice product, then build its concurrency/failure suite.
6. Add deployment-manifest tests before staging enablement.

## Exit gate

Do not interpret “all existing tests pass” as paid-feature readiness. Readiness
requires TEST-GAP-01 through TEST-GAP-17 plus the lifecycle tests for the
specific feature being opened.
