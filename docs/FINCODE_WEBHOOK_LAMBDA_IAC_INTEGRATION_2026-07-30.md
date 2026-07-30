# fincode Webhook Lambda / IaC / reading integration

Status: local implementation complete; provider period API unverified; all new switches default off
Recorded: 2026-07-30

## Implemented locally

- HTTP API v2 Lambda composition for `POST /webhooks/fincode`
- strict config, signature Secret adapter, digest shop allow-list, 2.5 second internal deadline, fixed safe responses
- dedicated retained/SSE/PITR DynamoDB tables for event ledger, customer mapping, and light quota
- Node.js 22 Lambda, explicit log group, reserved concurrency 2, route and invoke permission
- a scoped role with exact table and Secret resources; no Scan, SQS, Bedrock, IAM, or wildcard resource
- light request reserve and worker completion/release in the existing reading transactions
- staging-only migration dry-run planner

No AWS, fincode, Secrets Manager, DynamoDB, API Gateway, Lambda, or production request was made.

## Fail-closed gates

The following parameters default to `false`:

- `FincodeWebhookEnabled`
- `FincodePeriodSourceEnabled`
- `ReadingLightQuotaEnabled`

The repository contains no verified official fincode subscription-period endpoint contract. In particular, endpoint, authentication, response schema, canonical timezone, retry/rate policy, and authoritative period fields are not established by saved evidence. The Webhook payload dates are not substituted. Consequently ACTIVE/RUNNING delivery returns retryable 503 while the period source is disabled or unavailable, and paid-light quota enforcement remains disabled until a reviewed period source and migrated records exist.

## Atomic boundaries

Webhook completion uses one `TransactWriteItems` operation for users membership, the current-period light quota record, and the ledger terminal state. Reading acceptance adds the quota reservation to the existing rate/job/history/idempotency transaction. Worker success adds quota consumption to job/history/idempotency/concurrency completion; terminal failure adds reservation release to the failure transaction. Free and deep modes do not use the light quota path.

## Deployment gates still required

1. obtain and archive the official fincode period API contract;
2. implement and review the live period source with injected HTTP and secret providers;
3. review CloudFormation change set with all three new flags false;
4. run migration dry-run against an explicit staging allow-list, then approve a separate apply;
5. deploy artifacts without enabling route processing;
6. perform staging signature, duplicate, failure, transaction, and rollback tests;
7. only then consider enabling period source, Webhook, and light quota in that order.

This document does not authorize a Change Set, deployment, migration apply, Webhook registration, or production operation.
