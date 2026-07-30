# fincode Membership, Light quota, and contract-period design

Status: local contracts implemented / AWS disconnected / runtime enablement closed
Recorded: 2026-07-30

## Scope

This document is the local design record for the users membership schema, the
trusted subscription-period source, the monthly paid-light quota, and their
connection to fincode Webhook atomic completion. No AWS, fincode, or production
request was made. No Lambda, IaC, IAM, table, migration, Secret, or Webhook was
created or changed.

## Membership schema v1

`membership_schema_version=shirone-membership-v1` is mandatory. The reviewed
fields are:

- `plan`: `free`, `light`, or `premium`
- `subscription_status`: `inactive` or `active`
- `deep_enabled`
- `monthly_voice_limit`, `monthly_voice_used`
- `extra_voice_remaining`
- `cancel_at_period_end`
- `current_period_start`, `current_period_end`
- `membership_version`
- `membership_source`
- `membership_updated_at`

The v1 policy is fixed: free/inactive, light/active, and premium/active. Light
does not grant deep; premium grants deep. Monthly voice and one-off voice
credits remain separate from paid-light quota. Webhook updates do not write raw
provider IDs or payloads, do not modify history, and do not consume voice or
deep quota.

All paid membership records require a canonical UTC period pair. Legacy or
unknown shapes fail closed and require an explicit migration. Membership
updates use optimistic `membership_version` conditions. Same-plan/same-period,
new-period renewal, incomplete billing, cancellation, and plan change are
classified by a pure transition function. Plan changes remain manual review.

## Trusted contract-period Source Port

`FincodeSubscriptionPeriodSource` receives only the environment, digest forms
of subscription/customer references, reviewed plan, event type, and provider
process date. It returns one of:

- `RESOLVED`: canonical UTC start/end, deterministic period digest, fixed
  source classification, and bounded source version
- `NOT_AVAILABLE`
- `CONFLICT`
- `UNAVAILABLE`

The local static implementation only returns pre-supplied reviewed records. It
does not derive a period from `process_date`, receive time, local timezone, or a
fixed number of days. An ACTIVE/RUNNING event without a valid resolved period
returns retryable 503 before ledger reservation. A conflict returns safe 409.
No live provider period adapter is implemented in this phase.

## Light monthly quota v1

The dedicated quota record uses:

- digest `quota_ref` derived from internal user ID and deterministic period ID
- canonical `period_id`, `period_start`, and `period_end`
- `plan`, fixed `limit` (light 5, premium 20)
- durable `used`, bounded reservations, completed request digests
- optimistic `version` and required `membership_version`
- server timestamps and TTL

Free has no paid-light quota. Same-period Webhook delivery performs condition
checks and never changes `used`, reservations, or limit. A new trusted period
creates a new absent item with `used=0`; it never overwrites an existing period.
Deep quota remains in the existing deep quota model.

## Reading lifecycle

The local pure builders are `reserveLightQuota`, `completeLightQuota`, and
`releaseLightQuota`.

- Reserve requires light mode, an active light/premium membership, exact plan,
  period, and membership version, an existing valid quota item, available
  capacity, and a digest request reference.
- Duplicate reserve and already-completed requests are idempotent.
- Complete removes the matching reservation and increments `used` exactly
  once. A duplicate completion emits no second write.
- Release removes only the matching reservation and never increments `used`.
- Version/period/membership conditions make concurrent stale writes conflict.
- Expired reservations are removed only as part of a later conditional write;
  no in-memory counter or rate-limit table is used as monthly authority.

The final DynamoDB reading adapter must include the quota action in the same
transaction as job/history/idempotency completion or failure. That wiring is a
separate Lambda/IaC integration task; the local command contract is ready for
it and does not itself send AWS requests.

## Webhook atomic completion

For a new trusted period, one bounded transaction contains:

1. conditional users membership update;
2. absent-only light quota creation;
3. conditional ledger completion.

For the same period, it condition-checks the exact users membership and quota
without resetting usage, then completes the ledger. INCOMPLETE and plan-change
paths grant no entitlement or quota. Cancellation does not infer effective
expiry and remains a separately reviewed process.

The transaction is rejected unless period identity matches its canonical
start/end digest. `monthly_voice_used`, `extra_voice_remaining`, deep quota,
history, and provider payloads are outside the mutation set.

## Migration and enablement gates

No migration is performed here. Before runtime enablement:

1. inventory and migrate eligible users to membership schema v1;
2. validate existing period data and classify unresolved legacy records;
3. create the reviewed light quota table and initial period items atomically;
4. implement the trusted live period-source adapter;
5. wire reading reserve/complete/release into existing job transactions;
6. add staging-only Lambda/IaC/IAM with all flags false;
7. test duplicate, concurrent, failure, renewal, and rollback behavior in
   staging before any production decision.

Until every gate passes, ACTIVE/RUNNING success remains fail closed.

## Local judgment

```text
READY FOR LOCAL LAMBDA/IAC INTEGRATION
```

This judgment authorizes only a separately reviewed local Lambda/IaC
integration phase. It does not authorize AWS access, deployment, migration,
Webhook registration, entitlement updates, or production enablement.
