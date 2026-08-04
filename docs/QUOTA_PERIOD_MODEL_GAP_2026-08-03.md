# Quota Period Model Gap

Date: 2026-08-03

## Current models

| Feature | Product amount | Period source | Persistence | AWS actual |
| --- | ---: | --- | --- | --- |
| Light plan Light readings | 5 | trusted subscription period | `FincodeLightQuotaTable` | NOT_DEPLOYED |
| Premium Light readings | 20 | trusted subscription period | `FincodeLightQuotaTable` | NOT_DEPLOYED |
| Premium Deep readings | 3 | JST calendar `YYYY-MM` | `ReadingDeepQuotaTable` | DEPLOYED, execution disabled |
| Light monthly Voice | 3 | reset authority undefined | Users counters | catalog/entitlement drift |
| Premium monthly Voice | 10 | reset authority undefined | Users counters | legacy AWS actual unknown |
| one-time Voice | +1 | no monthly period | `extra_voice_remaining` plus idempotent grant ledger | local only |

## Contract-period month

Advantages:

- aligns Light quota with fincode subscription start/end;
- handles mid-month signup and renewal naturally;
- membership version and period can be checked in one transaction.

Costs:

- user-facing “monthly” periods vary by signup date;
- migration needs trustworthy period boundaries;
- Deep and Voice would need conversion if unified to this model.

## JST calendar month

Advantages:

- easy to explain;
- matches the deployed Deep quota model;
- operational reporting is simple.

Costs:

- partial first months and renewal dates need policy;
- fincode event periods no longer directly define usage periods;
- changes to existing Light quota schema and Webhook transaction would be
  required.

## Migration impact

| Change | Impact |
| --- | --- |
| Keep current mixed model | lowest code change; requires very clear product wording |
| Move Deep to contract period | Deep key migration and active reservation handling |
| Move Light to JST month | Webhook/light schema rewrite and initial-month policy |
| Move Voice to contract period | replace unclear reset authority and migrate counters |
| Move all to JST month | common reporting, largest fincode-period decoupling |

No period model is selected in this audit. The decision must be made together
with product wording, renewal behavior, refunds/cancellations and migration.

## Light Voice 3 gap

Catalog and strict membership-v1 both define active Light with
`monthly_voice_limit=3`. The shared entitlement implementation currently grants
monthly Voice only when `plan=premium` and active.

Required future regression cases:

- active Light with limit 3 can use exactly three monthly units;
- inactive Light cannot use stale monthly counters;
- Premium can use ten monthly units;
- extra Voice remains independently consumable by free/Light/Premium according
  to the final product definition;
- concurrent requests cannot overbook one remaining unit.

Classification: `P1_PRODUCT_ENTITLEMENT_DRIFT`.

## Legacy Voice state machine

```text
Bearer token -> user_id
  -> read Users counters
  -> check remaining (no reservation)
  -> upload S3
  -> start Transcribe
  -> put processing History
  -> transcript event
  -> locate History (scan fallbacks exist)
  -> Bedrock/result generation
  -> mark History completed
  -> read Users counters again
  -> increment monthly used OR decrement extra
     \-> consume error is logged/skipped
```

Missing invariants:

- `NO_DOUBLE_CONSUME`
- `NO_OVERBOOK`
- `FAILED_JOB_RELEASES_RESERVATION`
- `HISTORY_AND_CONSUME_ATOMIC_OR_RECOVERABLE`

The future Voice flow needs reserve/process/complete/release and event
idempotency before public reopening. This audit does not implement it.

## Verdict

```text
LIGHT_PERIOD_MODEL: DESIGNED_NOT_DEPLOYED
DEEP_PERIOD_MODEL: DEPLOYED_FAIL_CLOSED
VOICE_PERIOD_MODEL: UNRESOLVED
UNIFIED_PERIOD_POLICY: DECISION_REQUIRED
```
