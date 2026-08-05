# fincode TEST signed webhook E2E execution result

Date: 2026-08-03

## Final verdict

`FINCODE_TEST_BLOCKED_CONTRACT_PERIOD`

The Premium TEST plan was created successfully, but the task stopped before
TEST payment creation, webhook registration, fixture mutation, feature-flag
changes, or staging deployment. The remaining provider timestamp contract
cannot be replaced with an inferred timezone or inferred contract date.

## Phase 1: TEST plan and product references

Read-only fincode TEST API inspection found:

- one active 980 JPY monthly plan matching the Light catalog contract;
- exactly one active 2,980 JPY monthly plan matching the Premium catalog
  contract after duplicate-safe creation;
- no existing TEST webhook settings;
- no production webhook URL registered in TEST.

The existing deployed staging allow-list does not contain the actual matching Light plan reference. Its two current entries are local placeholder references and must not be treated as fincode TEST evidence.

`voice_single` is a fixed 300 JPY one-time payment contract, not a fincode subscription plan. The deployed Canonical webhook Lambda accepts only `subscription.card.regist`, `subscription.card.update`, and `subscription.card.delete`; it does not implement a signed `payments.card.*` one-time-grant route.

No provider identifiers, plan IDs, webhook IDs, signature values, API keys, or raw responses were displayed or saved.

The official `payments.card.*` contract identifies `order_id` as the payment
information ID, so the server-side payment GET linkage is no longer ambiguous.

## Contract-period blocker

The deployed Lambda has `FincodePeriodSourceEnabled=false`. More importantly, the production Lambda composition does not construct a trusted period-source adapter. When the flag is enabled, the handler passes only an optional injected test dependency; the deployed handler has no such dependency. ACTIVE/RUNNING events therefore fail closed before membership or quota completion.

This is the correct safe behavior. A period must not be inferred from webhook receipt time, process date, current date, or an assumed calendar month.

## Mutation performed

- fincode TEST Premium plan creation: 1.

## Mutations not performed

- fincode TEST payment creation: 0;
- fincode TEST webhook registration: 0;
- staging fixture writes: 0;
- staging feature-flag changes: 0;
- DynamoDB entitlement or quota writes: 0;
- AWS production mutations: 0;
- production API requests: 0;
- fincode PROD requests: 0;
- commit, push, or PR: 0.

## Minimum next work

1. Obtain authoritative timezone/instant semantics for fincode subscription
   `start_date` and `next_charge_date`.
2. Replace placeholder plan mapping with the reviewed Light and Premium TEST
   references through a Change Set.
3. Implement and test the trusted subscription-period adapter and the
   `payments.card.*` adapter in the existing Canonical Lambda composition.
4. Repeat Change Set review with all flags still false.
5. Only then create non-person fixtures, register TEST webhook settings, enable
   the minimum flags, and create TEST payments.

The existing staging endpoint remains deployed and disabled. The prior unsigned 503 fail-closed evidence remains valid.
