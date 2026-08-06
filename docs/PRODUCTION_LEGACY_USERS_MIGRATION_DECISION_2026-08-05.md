# Production legacy Users migration decision manifest

Date: 2026-08-05

## Purpose and boundary

This manifest supports the human decision required before Release B. It does
not authorize or perform migration, quota conversion, or any other production
write.

- Scope: the five records currently present in production `shirone7_users`.
- Boundary: the configured read-only production profile and
  `ap-northeast-1`; both Users and History table metadata matched that selected
  account and region.
- Users inspection: projection-only reads of the fields needed by this
  manifest. Password hashes, tokens, and secrets were not requested or
  displayed.
- History inspection: `Select=COUNT` queries by `user_id`. No reading text was
  requested or displayed. The five counts total 28, matching the current table
  inventory.
- Provider evidence: all five records contain only the legacy
  `stripe_customer_email` attribute. No customer-ID mapping, subscription-ID,
  payment-ID, or purchase-ID attribute was found. No production table whose
  name indicates a customer mapping, purchase, payment, subscription, fincode,
  or ledger store was found.
- Trusted period evidence: `あり` below means a non-empty stored value exists.
  An absent or empty value is `なし`; no date was inferred or synthesized.

## Recommendation rules

- `ACTUAL_PURCHASE`: a purchase-, payment-, or subscription-level mapping is
  present. No record met this evidence threshold.
- `INTERNAL_BETA_OR_MANUAL`: a clearly non-production/test identity has an
  active paid plan without purchase-level evidence.
- `FREE_WITH_LEGACY_VOICE`: a free/inactive identity retains non-zero legacy
  Voice limit or usage.
- `UNKNOWN`: the available evidence cannot safely distinguish an actual
  purchase from a manual or beta assignment.

These are recommendations for human review, not automatic migration inputs.

## Five-user decision table

| Masked user_id | Current plan | subscription_status | Legacy membership attributes | Provider / purchase mapping | Trusted start / end | monthly_voice_limit | monthly_voice_used | extra_voice_remaining | History count | Created at | Updated at | Recommended classification |
|---|---|---|---|---|---|---:|---:|---:|---:|---|---|---|
| `ara***29@gmail.com` | `premium` | `active` | あり（旧属性群、canonical version metadataなし） | provider: 旧Stripe email属性のみ / purchase: なし | なし / なし（endは空値） | 20 | 4 | 0 | 3 | `2026-06-10T08:51:43.562590+00:00` | `2026-07-07T03:52:16.715243+00:00` | `INTERNAL_BETA_OR_MANUAL` |
| `tes***st@test.com` | `premium` | `active` | あり（旧属性群、`cancel_at_period_end`なし、canonical version metadataなし） | provider: 旧Stripe email属性のみ / purchase: なし | なし / あり | 20 | 2 | 0 | 1 | なし | `2026-06-07T01:38:23.920999+00:00` | `INTERNAL_BETA_OR_MANUAL` |
| `tes***t2@test.com` | `free` | `inactive` | あり（旧属性群、canonical version metadataなし） | provider: 旧Stripe email属性のみ / purchase: なし | なし / なし（endは空値） | 100 | 42 | 0 | 20 | `2026-06-10T02:52:44.498330+00:00` | `2026-06-29T08:11:44.246088+00:00` | `FREE_WITH_LEGACY_VOICE` |
| `tes***t3@test.com` | `light` | `active` | あり（旧属性群、canonical version metadataなし） | provider: 旧Stripe email属性のみ / purchase: なし | なし / なし（endは空値） | 0 | 0 | 0 | 0 | `2026-06-29T01:47:17.378584+00:00` | `2026-06-29T01:47:30.492331+00:00` | `INTERNAL_BETA_OR_MANUAL` |
| `tes***t4@test.com` | `premium` | `active` | あり（旧属性群、canonical version metadataなし） | provider: 旧Stripe email属性のみ / purchase: なし | なし / なし（endは空値） | 20 | 0 | 20 | 4 | `2026-06-29T02:02:24.241474+00:00` | `2026-08-05T08:27:47.775246+00:00` | `INTERNAL_BETA_OR_MANUAL` |

## Operator decision recorded on 2026-08-06

The operator identified `ara***29@gmail.com` as Yoko's internal beta account.
It is not an actual purchase. All four paid records are approved as non-billing,
non-renewing manual grants; no payment or subscription mapping is to be
created.

The operator supplied this fixed period for all paid manual grants:

- start: `2026-08-01T00:00:00+09:00`
- end: `2026-09-01T00:00:00+09:00`

Canonical UTC storage is the deterministic representation of those supplied
instants (`2026-07-31T15:00:00.000Z` to
`2026-08-31T15:00:00.000Z`); it is not inferred from processing or receipt
time.

| Masked user_id | Approved target | Canonical Light | Canonical Deep | Canonical monthly Voice | Canonical Voice used | Canonical extra Voice | Legacy counter disposition |
|---|---|---:|---:|---:|---:|---:|---|
| `ara***29@gmail.com` | premium / active / `LEGACY_MANUAL_GRANT` / non-renewing | 20 | 3 | 10 | 0 | 0 | limit 20 / used 4 retained only in migration audit snapshot |
| `tes***st@test.com` | premium / active / `LEGACY_MANUAL_GRANT` / non-renewing | 20 | 3 | 10 | 0 | 0 | legacy values retained only in migration audit snapshot |
| `tes***t2@test.com` | free / inactive / non-renewing | 0 | 0 | 0 | 0 | 0 | limit 100 / used 42 expired; no one-time Voice conversion; audit snapshot only |
| `tes***t3@test.com` | light / active / `LEGACY_MANUAL_GRANT` / non-renewing | 5 | 0 | 3 | 0 | 0 | legacy values retained only in migration audit snapshot |
| `tes***t4@test.com` | premium / active / `LEGACY_MANUAL_GRANT` / non-renewing | 20 | 3 | 10 | 0 | 0 | legacy extra Voice 20 expired; no canonical transfer; audit snapshot only |

Release B migration must use conditional writes, remain idempotent, preserve
the original identity/password attributes and all 28 History records, retain a
rollback-capable legacy membership snapshot, and reconcile owner/count/plan/
quota before and after application. Source records must not be deleted.

## Safety result

- Release B apply: not executed.
- AWS mutations: 0.
- Quota conversions: 0.
- Date inference: 0.
- Reading bodies displayed: 0.
- Secret, password hash, or token displayed: 0.
- Commit, push, or PR: 0.
