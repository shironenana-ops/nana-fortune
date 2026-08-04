# Mock to fincode TEST to Production Gate

Date: 2026-08-03

## Provider boundary

The same application service must be exercised with exactly one provider
adapter selected by environment:

```text
MockPaymentProvider
FincodeTestPaymentProvider
FincodeProdPaymentProvider
```

TEST or production behavior must not be copied into a separate entitlement
implementation.

## Mock exit gate

All cases must pass before fincode TEST integration:

- Free, Light monthly, Premium monthly and `voice_single`;
- payment success and failure;
- 3DS/callback alone never grants entitlement;
- only a verified webhook grants entitlement;
- identical webhook repeated 10 times grants once;
- concurrent duplicates grant once;
- retry after injected failure;
- idempotency replay and payload conflict;
- quota exhaustion and approved monthly-period renewal/reset;
- monthly Voice consumed before extra balance;
- History failure produces no partial Users/ledger/quota success;
- paid runtime fails closed when dependencies or configuration are missing.

## fincode TEST exit gate

- staging-only URL and credentials;
- real browser 3DS return followed by server-side payment verification;
- webhook signature verification and canonical purchase lookup;
- amount, product, user ownership and contract period resolved server-side;
- duplicate/concurrent delivery and recovery cases repeat the Mock outcomes;
- secrets, card data, payment body and PII absent from logs/evidence;
- TEST flags can be returned to closed state with no residual worker activity.

## Production Definition of Ready

- PRs 1-8 in the migration plan are complete;
- canonical production account and data migration are approved;
- public membership P0 boundary is replaced and regression-tested;
- staging uses the same contracts and IaC generation as production;
- fincode TEST E2E passes with one application service;
- rollback rehearsal and data reconciliation pass;
- production credentials/endpoints are the only provider-specific change;
- feature flags, worker mappings and Bedrock remain fail closed until the
  production Change Set is separately reviewed and approved.

## Current status

| Gate | Ready |
|---|---|
| Mock specification | YES |
| Mock implementation proof | NO |
| fincode TEST unified E2E | NO |
| Production promotion | NO |
