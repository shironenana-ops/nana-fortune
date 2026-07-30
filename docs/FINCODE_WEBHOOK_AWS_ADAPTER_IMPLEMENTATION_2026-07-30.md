# fincode Webhook AWS Adapter local implementation

Status: local implementation complete / AWS disconnected / success path fail closed
Recorded: 2026-07-30

## Scope

This change implements local AWS command adapters behind the reviewed Webhook
Ports. All AWS clients are injected. Importing or composing the adapters sends
no request. No Lambda, IaC, IAM, table, endpoint, Secret, Webhook registration,
or production configuration was created or changed.

## Implemented adapters

- Ledger: conditional digest-keyed `PutItem`, consistent duplicate lookup,
  retryable-state reservation, and conditional retryable failure update.
- Customer mapping: SHA-256 digest lookup by opaque customer reference followed
  by a consistent users membership-snapshot read. No email lookup, scan, or query.
- Atomic completion: one `TransactWriteItems` command containing at most users,
  dedicated light quota, and ledger mutations. It never touches deep usage,
  `monthly_voice_used`, or `extra_voice_remaining`.
- Signature Secret: exact-identifier `GetSecretValue`, bounded process-local
  cache, fixed JSON key support, and fixed non-leaking failure.
- Configuration and composition: exact environment/config validation and
  dependency injection with no top-level SDK client construction.

## Atomicity and quota invariants

The transaction requires the expected ledger fingerprint/state/environment and
the expected users membership schema/version/plan/status/period. The light quota
update uses a digest key and `if_not_exists(used, 0)`, so an existing same-period
usage count is never reset. A new period initializes only an absent counter.
Deep quota is neither granted nor reset by the Webhook transaction.

The deterministic transaction token is derived only from semantic digests and a
fixed action domain. Raw provider IDs and raw internal user IDs are not written
to the ledger.

## Fail-closed gates

Atomic mutation is unavailable unless all of the following are explicit:

- `FINCODE_WEBHOOK_ENABLED=true`
- a dedicated `FINCODE_MEMBERSHIP_QUOTA_TABLE`
- `FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION=shirone-membership-v1`
- matching Webhook and Secret environments

The reviewed fincode event does not contain a trustworthy contract period.
Therefore the default local completion-plan factory returns no plan for
ACTIVE/RUNNING events. It does not infer a period from process/start/stop dates
or the local calendar. INCOMPLETE and CANCELED can only produce bounded
manual-review billing records without granting/revoking entitlement or quota.

Consequently, this implementation does not open an entitlement success path.
Providing a trusted contract period source, deploying the reviewed users/light
quota schemas, and reviewing the reading-side light consumption path are later
gates.

## Configuration keys

- `FINCODE_WEBHOOK_ENVIRONMENT`
- `FINCODE_WEBHOOK_SIGNATURE_SECRET_ENVIRONMENT`
- `FINCODE_WEBHOOK_ENABLED`
- `FINCODE_WEBHOOK_LEDGER_TABLE`
- `FINCODE_CUSTOMER_MAPPING_TABLE`
- `USERS_TABLE_NAME`
- `READING_DEEP_QUOTA_TABLE_NAME`
- `FINCODE_MEMBERSHIP_QUOTA_TABLE` (required to enable mutation)
- `FINCODE_WEBHOOK_SIGNATURE_SECRET_ID`
- `FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS` (30–730)
- `FINCODE_WEBHOOK_SECRET_CACHE_TTL_SECONDS` (30–3600)
- `FINCODE_WEBHOOK_ALLOWED_SHOP_DIGESTS`
- `FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING`
- `FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION` (required to enable mutation)

No plaintext signature is accepted from configuration.

## Remaining integration work

1. Review and deploy dedicated ledger, customer-mapping, and light-quota schemas.
2. Add the reviewed membership schema/version fields to staging users records.
3. Establish a separately trusted contract-period source.
4. Integrate a local Lambda handler with `maxAttempts: 1` clients and deadline handling.
5. Add staging-only IaC/IAM and validate it through a separate Change Set workflow.
6. Implement and review reading-side light quota consumption before enablement.

Final local judgment:

```text
READY FOR LOCAL LAMBDA/IAC INTEGRATION
```
