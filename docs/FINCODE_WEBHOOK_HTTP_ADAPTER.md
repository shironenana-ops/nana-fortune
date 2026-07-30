# fincode Webhook HTTP adapter and orchestrator

Status: local implementation only / AWS and fincode disconnected / entitlement mutation prohibited
Recorded: 2026-07-30

## Scope

The local implementation adds:

- a structural API Gateway HTTP API payload v2 event type
- strict raw and base64 body decoding with a decoded 64 KiB limit
- fixed HTTP response builders without CORS headers
- an orchestrator with explicit ordering and fail-closed classifications
- ledger reserve/failure, customer lookup, reviewed completion-plan, and atomic completion Port contracts
- allow-listed audit records

It does not add AWS SDK imports, a Lambda entry point, IaC, DynamoDB adapters,
entitlement mutation, network calls, secrets, or a Webhook registration.

## Processing order

The orchestrator executes in this order:

1. kill switch
2. HTTP API v2 structure, method, Content-Type, and body size
3. case-insensitive signature-header normalization
4. static signature comparison
5. JSON parsing
6. payload schema
7. staging environment boundary
8. normalized event construction
9. semantic digest and fingerprint
10. ledger reserve/lookup
11. duplicate or conflict handling
12. opaque customer-reference lookup
13. pure transition decision
14. reviewed mutation-plan availability
15. atomic entitlement/quota/billing/ledger completion
16. fixed audit record
17. fixed response

No raw payload, signature, provider identifier, email, user reference,
repository item, exception message, stack trace, or AWS request ID is written to
the audit record.

## Responses

| Classification | HTTP | Body |
| --- | ---: | --- |
| acknowledged | 200 | `{"receive":"0"}` |
| retry | 503 | `{"receive":"1"}` |
| permanent validation rejection | 400 | fixed rejection body |
| signature rejection | 401 | fixed rejection body |
| idempotency conflict | 409 | fixed rejection body |

The fixed rejection body is
`{"receive":"1","code":"FINCODE_WEBHOOK_REJECTED"}`. No response contains an
internal exception or detailed denial reason.

## Ledger contract

`reserve` returns one of `RESERVED`, `DUPLICATE_COMPLETED`,
`DUPLICATE_IN_PROGRESS`, `CONFLICT`, or `UNAVAILABLE`. Inputs contain only the
semantic digest, payload fingerprint, and explicit validated TTL. Retryable
failure recording remains on `ledger.fail`; successful completion is not part
of this Port.

`FincodeWebhookAtomicCompletionPort.applyAndComplete()` is the only success
completion path. Its request contains digest identity, expected `RESERVED`
state, mapped internal user reference, a raw-ID-free normalized event summary,
a reviewed plan/period/entitlement/quota/billing mutation plan, fixed result
code, digest-only correlation, validated retention, and completion time. A
future AWS adapter must apply the users, quota, billing, and ledger final-state
changes in one transaction. No separate entitlement writer or
`ledger.complete()` success path remains.

Retention has no default. The caller must provide positive integer TTL,
minimum, and maximum values, and the TTL must be inside the inclusive range.
Invalid or missing configuration returns a retry response before repository
access.

## Current mutation boundary

The orchestrator requires both a reviewed completion-plan factory and an atomic
completion Port. Missing or invalid plans, unavailable/retryable completion,
unknown completion results, or exceptions return fixed 503 responses. A 200 is
returned only for `COMPLETED`, `ALREADY_COMPLETED`, or a ledger reservation that
already proves `DUPLICATE_COMPLETED`. Conditional conflict returns fixed 409.

A syntactically valid customer reference with no mapping is retryable 503;
malformed or wrong-environment references remain permanent 400. Plan-change and
`INCOMPLETE` plans can be acknowledged only after a mutation-free/manual-review
state is atomically committed. The AWS adapter, DynamoDB transaction, Lambda,
IaC, IAM, Secret lookup, and real entitlement mutation are still unimplemented.
