# fincode TEST webhook reachability plan

Date: 2026-08-03

## Current evidence

A read-only inspection of the verified `shirone-staging` account and `ap-northeast-1` region found:

- staging stack status: `UPDATE_COMPLETE`;
- deployed CloudFormation resources whose logical ID begins with `FincodeWebhook`: 0;
- therefore no deployed canonical `POST /webhooks/fincode` route is available to fincode TEST.

No account identifier, ARN, physical resource ID, secret, or production resource was displayed or saved. No mutation or API request to production was performed.

## Decision

`FINCODE_TEST_BLOCKED_WEBHOOK_REACHABILITY`

The existing browser callback and server-side payment re-query can verify a payment result, but they cannot prove the required webhook delivery, duplicate-delivery behavior, or atomic grant boundary. A callback must not be substituted for the webhook.

## Minimum TEST-only change

Use the already implemented canonical webhook Lambda, adapters, ledger, mapping, quota, and atomic completion contract from the current repository. Do not create another handler or source of truth.

The reviewed staging Change Set should add only the existing template's staging resources required for this path:

- `FincodeWebhookFunction` and its log group;
- `FincodeWebhookHttpApi`, staging stage, integration, route, and invoke permission;
- `FincodeWebhookRole` with the existing minimum policy;
- `FincodeWebhookLedgerTable`;
- `FincodeCustomerMappingTable`;
- `FincodeLightQuotaTable` if it is not already deployed by the same stack;
- references to the existing staging Users table only.

The endpoint remains disabled initially. `FincodeWebhookEnabled` and `FincodePeriodSourceEnabled` must stay `false` during resource creation and boundary verification.

## Required configuration names

Values must not be committed or printed. The existing configuration contract requires the TEST-only signature secret reference, allowed shop digests, allowed plan mapping, customer-reference prefix, environment, ledger retention, and reviewed membership schema version. The TEST signature secret must not be shared with production.

## IAM boundary

- logs: own log group only;
- DynamoDB read: webhook ledger, customer mapping, and staging Users only;
- ledger reserve: webhook ledger only;
- atomic transaction: webhook ledger, staging Users, and staging Light quota only;
- Secrets Manager: the single TEST webhook signature secret only;
- no fincode outbound API permission;
- no production table, secret, API, or wildcard mutation permission.

## Deployment gate

1. Build and hash the existing canonical webhook artifact locally.
2. Confirm the staging stack is in sync and all unrelated kill switches remain off.
3. Create a Change Set from the reviewed template.
4. Require that the diff contains only the resources and references listed above, with no production identifier or replacement/removal of existing reading resources.
5. Obtain separate human approval immediately before execution.
6. Deploy with both webhook switches still off.
7. Verify route ownership, Lambda configuration names, IAM, table encryption/PITR/deletion protection, and fixed disabled response.
8. Populate only explicit non-personal TEST fixture mapping/membership records under a separately approved data-mutation step.
9. Enable the period source and webhook in separate reviewed changes, then register only the staging URL in fincode TEST.

## Required verification after reachability exists

- callback-only grant remains 0;
- verified Light and Premium events grant catalog-correct membership and contract-period quotas;
- `voice_single` grants exactly one extra allowance;
- identical verified webhook delivered 10 times produces one payment unit and one grant;
- invalid signature, failed/cancelled/incomplete payment, wrong amount, plan, owner, or conflicting replay grants 0;
- monthly Voice is consumed before extra Voice;
- logs contain no raw identity, payload, signature, payment secret, or result body.

## Rollback and cleanup

Immediately set both webhook switches to `false`, remove the fincode TEST webhook registration, and verify no further deliveries. Retained TEST ledger/mapping/quota records remain isolated for audit until an explicitly approved cleanup. Do not delete retained tables or logs during emergency rollback. Production is unaffected because no production resource or endpoint is referenced.
