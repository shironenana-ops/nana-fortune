# Staging cleanup manifest

Date: 2026-08-03

This manifest contains no provider identifiers or secret values.

## Retained TEST resource

- One fincode TEST Premium monthly plan, created during billing-contract
  completion after a duplicate check.
- Catalog semantics: 2,980 JPY, tax 0, monthly interval, interval count 1.
- Cleanup status: retained; deletion was not authorized.

## Not created in this run

- webhook settings;
- TEST subscriptions;
- TEST card payments;
- staging fixture records;
- AWS Change Sets or deployed resources.

## Retained TEST subscriptions (2026-08-04)

- Two previously created Light/Premium TEST subscriptions with a future-date
  start condition were retained without deletion. Both remained unsuitable for
  signed entitlement E2E because their provider period boundaries were equal.
- One new Light TEST subscription and one new Premium TEST subscription were
  created for the explicitly supplied TEST start date `2026/08/04`, using the
  existing non-person TEST customers and their registered TEST cards.
- The new subscriptions were re-read from fincode TEST immediately after
  creation; both were ACTIVE/RUNNING with `start_date < next_charge_date` and
  independently classified `RESOLVED` by the staging-only trusted-period rule.
- Provider subscription IDs, customer IDs, plan IDs, card information, Secret
  values, and raw provider responses are intentionally excluded from this file.
- Cleanup status: all four TEST subscriptions are retained; deletion was not
  authorized.
