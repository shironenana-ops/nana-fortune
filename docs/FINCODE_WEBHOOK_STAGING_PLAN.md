# fincode Webhook staging plan

Status: plan only / no AWS or fincode configuration performed
Recorded: 2026-07-30

## Current boundary

The repository contains a pure local foundation, a structural API Gateway HTTP
API v2 adapter, a local orchestrator, and Port contracts. It still has no Lambda
handler, API Gateway route, DynamoDB adapter/writer, AWS SDK adapter, Webhook
secret, deployed endpoint, or fincode Webhook registration. Production use is
prohibited until all gates below pass.

Existing `/join`, terms, commercial-transactions, and MOSH operations copy still
describe the current MOSH manual flow. They are deliberately unchanged in this
phase. Before direct fincode sales are opened, review at least:

- `src/pages/join.astro`
- `src/pages/terms.astro`
- `src/pages/commercial-transactions.astro`
- `src/pages/privacy.astro`
- `docs/MOSH_FINCODE_SETUP.md`
- `docs/MOSH_FINCODE_OPERATIONS.md`
- `docs/MOSH_FINCODE_RELEASE_CHECKLIST.md`

## Gate 1: local adapter design approval (implemented, mutation closed)

The HTTP response mapping, strict body handling, signature-first order,
digest-only ledger contract, and fixed audit classification are implemented and
covered by local tests. These business decisions remain prerequisites:

- exact entitlement values for each staging plan
- cancellation timing
- `INCOMPLETE` handling
- plan-update behavior
- customer-reference generation and storage lifecycle
- concrete ledger and audit retention values

The local Port contract now requires a single atomic completion operation and
has no independent entitlement-writer/ledger-complete success path. Before any
staging deployment, add in separate reviewed changes:

- Lambda handler with a three-second budget
- Secrets Manager/dynamic-reference configuration
- conditional/transactional ledger repository
- customer-reference lookup adapter
- reviewed completion-plan resolver and atomic DynamoDB completion adapter

## Gate 2: AWS Change Set approval

The staging Change Set should contain only explicitly reviewed resources:

- staging Webhook HTTP route and integration
- staging Webhook Lambda and log group
- dedicated least-privilege role
- dedicated payment-event ledger with encryption, PITR, and conditional writes
- staging signature secret reference
- `FINCODE_WEBHOOK_ENABLED=false`
- exact shop and plan allow-list configuration

Reject the Change Set if it references production, broadens existing reading
roles, uses wildcard data permissions, or changes reading queues/workers.

Deploy with the kill switch off. Confirm no production resource is reachable.

## Gate 3: fincode test-mode configuration approval

After the disabled endpoint is deployed and reviewed:

1. Configure a test-mode-only Webhook URL.
2. Configure a new staging-only static signature.
3. Register only the three supported subscription events.
4. Do not register `recurring.card.batch` or payment/refund events.
5. Confirm the staging shop and plan IDs match the allow-lists without recording
   their raw values in reports.
6. Keep production Webhooks unchanged.

## Gate 4: one-event staging test approval

Use a fixed non-personal staging test account and opaque staging customer
reference. Do not use email as the mapping key.

Test in this order:

1. Verify tables, logs, endpoint, secret reference, allow-lists, and kill switch.
2. Snapshot the test user's entitlement fields and ledger count.
3. Enable only the Webhook kill switch.
4. Send one `subscription.card.regist` test event.
5. Expect one ledger record and exactly one approved entitlement transition.
6. Confirm reading history, queues, workers, Bedrock, and unrelated users are unchanged.
7. Replay the exact event; expect duplicate success and no second mutation.
8. Reuse the semantic key with a changed canonical field; expect conflict and no mutation.
9. Test mismatched signature, unknown event, unknown status, unknown shop/plan,
   production identifier, invalid customer reference, invalid JSON, and oversized body.
10. Verify no raw payload, signature, PII, or provider IDs appear in logs.
11. Restore the test user and disable the Webhook kill switch.
12. Confirm production access count is zero.

## Failure and rollback

Immediately stop and disable the Webhook when:

- an unexpected resource changes
- a production identifier is observed
- signature or allow-list configuration is ambiguous
- the ledger and users update diverge
- duplicate delivery changes entitlement twice
- raw identifiers or payload enter logs
- response time approaches three seconds
- provider retry behavior differs from the fixed contract

Rollback consists of disabling the kill switch first, restoring only the
approved test user's prior entitlement state through an audited procedure,
retaining the conflict/incident evidence without raw payload, and reviewing a
separate Change Set before removing infrastructure.

## Later phases not covered here

- recurring payment failure lookup
- payment, refund, cancellation, and chargeback events
- 3-D Secure production flow
- production Webhook registration
- general paid-feature release
