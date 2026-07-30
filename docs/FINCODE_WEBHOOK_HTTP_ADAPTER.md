# fincode Webhook HTTP adapter and orchestrator

Status: local implementation only / AWS and fincode disconnected / entitlement mutation prohibited
Recorded: 2026-07-30

## Scope

The local implementation adds:

- a structural API Gateway HTTP API payload v2 event type
- strict raw and base64 body decoding with a decoded 64 KiB limit
- fixed HTTP response builders without CORS headers
- an orchestrator with explicit ordering and fail-closed classifications
- ledger, customer lookup, and entitlement writer Port contracts
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
10. atomic ledger reserve/lookup
11. duplicate or conflict handling
12. opaque customer-reference lookup
13. pure transition decision
14. mutation availability
15. fixed audit record
16. fixed response

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
semantic digest, payload fingerprint, and explicit validated TTL. `complete`
and `fail` use the same digest identity and a fixed result code.

Retention has no default. The caller must provide positive integer TTL,
minimum, and maximum values, and the TTL must be inside the inclusive range.
Invalid or missing configuration returns a retry response before repository
access.

## Current mutation boundary

All current transition results have `mutationAllowed: false`. A newly reserved
event therefore returns 503, records no completed ledger state, and calls no
entitlement writer. A completed duplicate may return 200 because the earlier
transaction is already the source of truth. Repository/writer implementation
requires a separate reviewed phase after business transitions and retention are
approved.
