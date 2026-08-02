# fincode 300円音声単体購入のローカル付与基盤

Status: `VOICE_SINGLE_GRANT_LOCAL_VERIFIED`
Recorded: 2026-08-03
Scope: local source, mocked persistence, and automated regression only.

## What this change establishes

The existing local TEST card flow remains a payment and 3DS verification path.
It does **not** mutate a real user or claim entitlement on its completion page.
This change adds a separate, deploy-unwired one-time purchase foundation for a
future staging Webhook path.

The required future sequence is:

1. A server-side authenticated session resolves the Shirone user reference.
2. The server creates the exact 300 JPY Card/CAPTURE payment.
3. Before card execution details can be returned, it conditionally persists a
   `REGISTERED` purchase intent keyed by a payment digest.
4. A dedicated one-time Webhook boundary verifies the fincode signature before
   parsing business data, then re-queries fincode server-side.
5. Only a verified `payments.card.capture` equivalent with the exact payment,
   shop, environment, amount, Card, CAPTURE, and captured-state boundary may
   reach the grant function.
6. One DynamoDB transaction changes the purchase state to `COMPLETED` and adds
   exactly one to `Users.extra_voice_remaining`.

Browser callback parameters, client user IDs, client amounts, and the success
screen are not a source of truth.

## Atomicity and duplicates

`DynamoFincodeOneTimeVoicePurchaseStore` uses a payment-digest keyed purchase
item. Its transaction contains:

- a conditional update from `REGISTERED` to `COMPLETED`, bound to the expected
  payload fingerprint, environment, product, and 300 JPY amount; and
- a conditional users update with `ADD extra_voice_remaining :one`.

Either both mutations commit or neither does. A transaction cancellation is not
treated as success. It is recovered as `ALREADY_COMPLETED` only after a
consistent read finds the same fingerprint in `COMPLETED`; otherwise it remains
retryable. This gives one grant for duplicate delivery and concurrent delivery.

The purchase table is intentionally separate from the subscription Webhook
ledger. Subscription state/period invariants are unchanged.

## Deliberately not wired in this change

- HTTP Webhook route and Lambda composition
- fincode TEST Webhook registration
- DynamoDB table/IAM/IaC/deploy
- real DynamoDB writes or real entitlement changes
- production access
- a change to the existing local TEST completion semantics

The direct payment Webhook payload field mapping and the dedicated staging
endpoint must be fixed against the current fincode official contract before
the AWS adapter is deployed. The source accepts a provider-verified capture
object rather than guessing that raw payload schema locally.

## Premium VOICE BALANCE 0/0 audit

The product catalog is correct:

| plan | `voiceMonthlyLimit` |
| --- | ---: |
| free | 0 |
| light | 3 |
| premium | 10 |

The membership v1 validator and atomic subscription completion writer also
require premium/active/deep-enabled to carry `monthly_voice_limit = 10`.

The member page does not apply a catalog fallback. It displays the values
returned by the existing user-status API through `getMembershipEntitlements()`.
Therefore a displayed premium `0 / 0` indicates that the persisted/API
membership record carried a zero or missing monthly limit; the UI is not the
source of that value. This source-only audit cannot identify a particular user
record and does not modify one.

Before any staging remediation, run a dry-run against active light/premium
records only. Require membership schema, plan, subscription status, and deep
flag consistency; preserve `monthly_voice_used` and
`extra_voice_remaining`; mutate already-correct records zero times; and fail
closed on unknown or inconsistent records. Production migration is outside this
change.

## Local evidence

- `tests/fincodeOneTimeVoicePurchase.test.mjs`
  - exact first grant
  - ten duplicate deliveries
  - mismatched amount/product/payment confirmation rejection
  - unknown intent and persistence failure with no mutation
  - durable-intent-before-card-release contract
- `tests/fincodeOneTimeVoiceDynamoAdapter.test.mjs`
  - conditional payment-digest intent write
  - two-item atomic transaction
  - duplicate recovery only after exact completed state
- Existing TEST payment, 3DS return, subscription Webhook, membership, and
  quota suites remain part of the full regression run.

## Staging gate

Do not set a grant feature flag, register a Webhook, or deploy this adapter
until all of the following are reviewed in a separate Change Set:

- staging-only endpoint, shop, signature secret, purchase table, and users
  table are unambiguous;
- the allowed one-time card capture event and payload-to-payment-reference
  mapping are verified against the current official fincode documentation;
- request role, Webhook role, and DynamoDB transaction permissions are
  minimal and staging-scoped;
- a non-personal dedicated staging user starts with
  `extra_voice_remaining = 0`;
- one successful delivery proves `0 -> 1`, and duplicate delivery leaves it
  at `1`;
- failure, wrong amount, unknown intent, and transaction failure prove no
  grant.
