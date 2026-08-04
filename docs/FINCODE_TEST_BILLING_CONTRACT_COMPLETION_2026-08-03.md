# fincode TEST billing contract completion

Date: 2026-08-03

## Final verdict

`FINCODE_TEST_BLOCKED_CONTRACT_PERIOD`

The Premium TEST plan gap was resolved, and the official webhook contract
confirms that `payments.card.*` supplies `order_id` as the payment-information
identifier used for server-side verification. The signed E2E did not proceed
because the trusted subscription-period conversion remains under-specified.

## Completed item

- Re-listed fincode TEST plans before mutation to prevent duplicate creation.
- Confirmed the existing Light plan remains the single matching active 980 JPY
  monthly plan.
- Created exactly one Premium TEST plan matching 2,980 JPY, tax 0, monthly
  interval, interval count 1, with a TEST/staging-identifiable name.
- Re-listed the catalog and confirmed exactly one matching Premium TEST plan.
- The returned plan identifier and raw provider response were not displayed,
  logged, or written to repository files.

The created Premium TEST plan is retained as a TEST cleanup-manifest item. It
was not deleted because cleanup was not authorized.

## Confirmed payment-event contract

The official fincode webhook reference defines `order_id` in a
`payments.card.*` payload as the payment-information ID. This removes the prior
ambiguity about which identifier is used for the required server-side payment
GET. A safe adapter can therefore use a signed event only as a trigger and
verify the payment independently before granting `voice_single`.

No payment adapter was deployed in this run because all four contract changes
were required to pass the common pre-E2E gate.

## Remaining blocker

The official subscription API documents `start_date` and `next_charge_date` as
`yyyy/MM/dd HH:mm:ss.SSS`, but the reviewed contract does not state a timezone.
The Canonical membership model requires exact ISO instants whose UTC
normalization is part of the period ID and DynamoDB transaction condition.

Consequently, the implementation cannot safely choose UTC, JST, process time,
the receive time, or a fixed duration. Any such choice would invent a contract
boundary and violate the no-inference rule. A provider-confirmed timezone rule
or an approved Canonical representation for these timezone-less provider
timestamps is required before the trusted period source can return `RESOLVED`.

## Work deliberately not performed

- Light/Premium plan allow-list deployment;
- trusted period adapter implementation or flag enablement;
- `payments.card.*` runtime deployment;
- TEST webhook registration;
- TEST subscription or one-time payment creation;
- fixture, membership, quota, ledger, or entitlement mutation;
- Change Set creation or staging deployment;
- production communication or mutation;
- commit, push, or PR.

Partial deployment was avoided because it would leave the Canonical billing
path in a knowingly incomplete state and could not satisfy the signed E2E gate.

## Required external clarification

Obtain an authoritative fincode answer for the timezone/instant semantics of
subscription `start_date` and `next_charge_date`, or approve an explicit
Canonical storage contract backed by equivalent authoritative evidence. After
that, connect the existing actual TEST plan references through staging
parameters, implement both adapters in the existing Canonical handler, review a
Change Set, and repeat the signed E2E.
