# Legacy and runtime drift report

Date: 2026-08-03

## Environment boundary

The repository currently describes two generations of runtime:

| Area | Legacy site generation | New reading staging generation |
| --- | --- | --- |
| Identity | browser-stored email/user ID and legacy login token | verified Bearer token, server-resolved user ID |
| Users | legacy `shirone7_users` family | CloudFormation `ReadingUsersTable` |
| History | legacy API/table and Voice S3 fields | `ReadingHistoryTable` public result |
| Status | legacy `/user/status` by query ID | `/reading/status` by owned opaque job ref |
| Light quota | no dedicated legacy table | `FincodeLightQuotaTable` per trusted period |
| Deep quota | no legacy monthly state found | `ReadingDeepQuotaTable` per JST month |
| Voice | Users counters plus legacy upload/Transcribe | no selected replacement runtime |

No cross-account application role, replication stream or identity mapping
between these generations was found. Lambda service trust in the template is
not a cross-account bridge.

## Runtime evidence status

- Human-confirmed before this audit: staging stack `UPDATE_COMPLETE`, drift
  `IN_SYNC`, reading routes fixed, kill switches false, ESM disabled, Bedrock
  false.
- Saved deployed-template artifact: 32 resources and no
  `FincodeLightQuotaTable`/Webhook resources.
- Current source template: 43 resources and includes the fincode Webhook,
  customer mapping, event ledger and Light quota.
- Current live read-only refresh: not completed because the staging SSO token
  was expired. The failed STS call made no AWS change.

Therefore the local 43-resource template must not be described as deployed
without a refreshed AWS read.

## Membership drift

### Intended membership v1

Paid records require:

- `membership_schema_version=shirone-membership-v1`
- monotonic `membership_version`
- canonical current period start/end
- `membership_source`
- policy-consistent plan/status/deep/Voice limit

Premium requires active, `deep_enabled=true`, and Voice limit 10.

### Legacy-compatible read path

`getMembershipEntitlements()` accepts only the simple plan/status/deep/counter
fields. Missing period/schema/version does not stop Premium display or initial
mode resolution. This is why a manually edited legacy record can look valid.

### Strict mutation/quota path

The fincode customer mapping parser rejects missing period/schema/version.
Light quota also requires exact period and membership version. Consequently,
the same record can be visually Premium but operationally ineligible.

## Stripe drift

Legacy DynamoDB records may retain Stripe identifiers. The new membership
repository excludes them from its whitelist and automated tests verify that
Stripe-only attributes grant no entitlement. They are dead for the new server
foundation, but the implementation of the legacy status/change-plan APIs is
not present in this repository; their behavior remains unverified.

Do not delete those fields until the old API and rollback needs are audited.

## Plan-name drift

- Canonical server plans: `free`, `light`, `premium`.
- Legacy aliases: `normal`, `member`.
- Members UI normalizes Light back to `normal` for plan-card/change-plan logic.

This is a compatibility layer mixed into current UI, not a bounded adapter.

## Quota drift

| Concept | Correct value/source | Drift |
| --- | --- | --- |
| Premium Light | 20, dedicated Light quota | not visible in members status |
| Premium Deep | 3, dedicated Deep quota | UI says preparation only |
| Premium Voice | 10, Users membership field today | human test record manually set to 20 |
| Voice single | +1 extra, purchase ledger transaction | local-only; no runtime placement |

The human test record's `monthly_voice_limit=20` confuses Premium Light 20 with
Premium Voice 10. Its `extra_voice_remaining=20` is also not backed by a
purchase ledger.

## History drift

- New async status correctly treats new `ReadingHistoryTable` as the completed
  result source of truth.
- Existing history UI reads a separate hard-coded legacy API.
- Legacy Voice writes processing/result metadata into the old history model.

There is no single UI that can prove a complete view across both stores.

## Voice runtime drift

`docs/voice-upload-and-tts-boundary.md` states that uploaded consultation and
future TTS must remain separate. The current UI presents one “Voice” balance,
while the legacy uploaded-voice flow consumes the same Users counters. The
future one-time purchase adds to `extra_voice_remaining`, but has not selected
which execution product consumes that credit.

## Required decisions

1. Which AWS account owns canonical Users?
2. Is old History migrated, federated read-only, or archived?
3. Does one-time Voice buy uploaded consultation, TTS generation, or a named
   credit usable by one of them?
4. Is `deep_enabled` retained as a policy gate in v2 or replaced by a capability
   set?
5. Which endpoint replaces legacy `/user/status` and change-plan APIs?

## Verdict

```text
Legacy dependency: ACTIVE
Runtime/source alignment: PARTIAL
Cross-account ownership: UNRESOLVED
Safe automatic migration: NOT AUTHORIZED
Final verdict: BLOCKED_BY_CROSS_ACCOUNT_ARCHITECTURE
```
