# Canonical unification implementation result

Date: 2026-08-03

## Outcome

The local implementation now converges on the previously selected canonical architecture. It does not create a second membership, quota, history, or payment source of truth.

Implemented locally:

- canonical legacy user/history migration planners with fail-closed and manual-review outcomes;
- Light and Deep quota periods derived from the same trusted contract-period boundaries;
- Deep reservation conditions bound to membership version and exact period boundaries;
- atomic Voice completion that updates the existing user allowance and existing history item in one DynamoDB transaction;
- deterministic Voice allowance order: monthly premium allowance first, then one-time allowance;
- a token-derived canonical membership service that ignores client-supplied identity;
- public membership views no longer call the legacy unauthenticated API or send `user_id` in the query string;
- the legacy client-side plan mutation path fails closed instead of calling the Stripe-era endpoint.

## Source-of-truth boundaries

| Concern | Canonical source |
|---|---|
| Membership and allowances | existing `shirone7_users` item after canonical backfill |
| Reading history and Voice idempotency marker | existing `shirone7_history` item |
| Light/Deep period | trusted membership contract period |
| Payment event completion | existing fincode webhook ledger and one atomic completion transaction |

## Not changed

No AWS resource, deployed Lambda, production data, fincode endpoint, feature flag, secret, or external service was changed or contacted as part of this implementation gate. The currently deployed legacy public API remains unchanged until a separately reviewed migration/deployment phase.

## Remaining gates

- obtain and validate trusted period starts for existing paid records;
- decide the explicit handling of legacy counters above current catalog limits;
- implement a reviewed conditional write runner for the migration plans;
- deploy the canonical authenticated membership route and retire the legacy public route only after verification;
- apply and verify the Voice atomic adapter against the real table contract in staging;
- complete staging E2E and rollback evidence before production opening.
