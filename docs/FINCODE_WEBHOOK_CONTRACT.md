# fincode Webhook contract

Status: local foundation + HTTP/orchestrator only / no AWS adapter / no entitlement writer / production prohibited
Recorded: 2026-07-30

## Sources and scope

This document fixes the provider contract used by the local foundation. The
provider documentation was checked on 2026-07-30:

- <https://docs.fincode.jp/develop_support/development_monitoring>
- <https://docs.fincode.jp/api>
- <https://docs.fincode.jp/tutorial/test_webhook>
- <https://docs.fincode.jp/payment/subscription/attention>

No fincode API, dashboard, Webhook endpoint, AWS account, or secret was accessed.
The code under `src/server/fincode/` performs no network or database operations.
It includes a structural API Gateway HTTP API v2 adapter but imports no AWS SDK
types and is not a deployed Lambda handler.

## HTTP and response contract

- Method: `POST`
- Content-Type: `application/json`
- Endpoint: HTTPS, port 443
- Response deadline assumption: within three seconds
- Success: HTTP 200 with `{"receive":"0"}`
- Failure: `{"receive":"1"}` or a 4xx/5xx response causes retry
- Retry: at most five retries, six total deliveries, approximately twenty
  minutes between retries

The local adapter fixes these responses:

- atomically completed event, completed duplicate, or atomically committed safe manual review: `200 {"receive":"0"}`
- retryable failure: `503 {"receive":"1"}`
- permanent validation rejection: `400` with the fixed rejection body
- missing, ambiguous, or mismatched signature: `401` with the fixed rejection body
- semantic-key/fingerprint conflict: `409` with the fixed rejection body

The rejection body is
`{"receive":"1","code":"FINCODE_WEBHOOK_REJECTED"}`. It contains no internal
classification. A 4xx can still be redelivered by the provider; every repeat
must remain side-effect free.

Unsupported events are not registered in fincode. Receiving one is a
configuration or security signal, not an entitlement update.

## Authentication contract

- Header: `Fincode-Signature`
- Value: the static shared value configured with the Webhook
- This is not an HMAC, body hash, timestamp signature, or event-ID signature
- Verify the exact value before JSON parsing
- Accept exactly one unambiguous header value
- Compare through a constant-time path
- Never log the configured or received value

The local comparison hashes both candidate strings to fixed-size buffers only
to execute `timingSafeEqual`; it does not calculate or validate a provider HMAC.

## Supported subscription events

Only these events are accepted by v1:

- `subscription.card.regist`
- `subscription.card.update`
- `subscription.card.delete`

`recurring.card.batch`, `payments.card.*`, refund, cancel-payment, and every
other event are outside v1. `recurring.card.batch` is a summary and identifying
individual failures requires an additional API query, so it is deliberately not
part of the synchronous receiver.

## Payload schema

The official card-subscription payload contains the following fields used by
the foundation:

| Provider field | Local rule |
| --- | --- |
| `shop_id` | required, exactly 13 characters, staging allow-list |
| `subscription_id` | required by this receiver, 1-25 characters |
| `plan_id` | required, 1-25 characters, environment-specific allow-list |
| `customer_id` | required, 1-60 characters, opaque external customer reference |
| `status` | `ACTIVE`, `RUNNING`, `CANCELED`, or `INCOMPLETE` |
| `process_date` | required, `yyyy/MM/dd HH:mm:ss.SSS` |
| `start_date` | nullable, same date-time format |
| `stop_date` | nullable, same date-time format |
| `client_field_1..3` | nullable, 1-100 characters when present |
| `pay_type` | required by v1 and must be `Card` |
| `event` | one of the three supported events |

Known provider fields not needed for decisions are ignored after JSON parsing.
Unknown extra fields are also ignored and never copied to normalized output,
fingerprints, ledger contracts, or logs. Required known fields remain strict.
This policy tolerates additive provider fields without expanding authority.

The raw body is limited locally to 64 KiB and is never persisted.

## Environment boundary

The documented payload has no test/live field. The receiver therefore uses all
of these controls together:

- staging-only endpoint
- staging-only shared signature
- exact staging shop-ID allow-list
- exact staging plan-ID allow-list
- opaque customer reference with a staging prefix
- explicit production-identifier deny-list
- staging AWS account/table/IAM boundary
- `FINCODE_WEBHOOK_ENABLED=false` by default

Unknown or production identifiers fail closed. The implementation does not
invent or depend on an undocumented test/live field.

## User mapping

Email is forbidden as a mapping key. The future customer-registration flow must
generate a non-PII, unpredictable, environment-prefixed external customer
reference within fincode's 60-character `customer_id` limit. It is stored in the
users item and maps one-to-one to fincode `customer_id`.

`client_field_1..3` are optional auxiliary values and are not identity truth.
This change defines only validator and repository interfaces; it does not create
customers or write users.

## Idempotency

There is no documented provider event-ID header. The local foundation creates:

- semantic event digest from environment, shop ID, event, subscription ID,
  process date, and status
- payload fingerprint from an explicit canonical representation after schema
  validation

Raw identifiers are only digest inputs. The ledger contract stores digests,
normalized classification, status, and decision, never the raw payload.

- same semantic digest + same fingerprint: duplicate success; no second mutation
- same semantic digest + different fingerprint: conflict; no mutation; fail closed

The local ledger Port supports `reserve` and retryable `fail` operations. It
accepts only the two digests, an explicit validated TTL, and fixed result codes.
Successful entitlement/quota/billing changes and ledger completion are exposed
only through `FincodeWebhookAtomicCompletionPort.applyAndComplete()`. This makes
it impossible for the orchestrator to acknowledge between a writer call and a
separate ledger-completion call. No repository or AWS adapter exists in this
phase.

## Transition boundary

The pure decision function can return:

- `ACTIVATE_SUBSCRIPTION`
- `UPDATE_SUBSCRIPTION`
- `CANCEL_SUBSCRIPTION`
- `RECORD_INCOMPLETE`
- `NO_OP`
- `REJECT`

The pure transition classifier does not grant persistence authority. A separate
reviewed completion-plan factory must produce a strict raw-ID-free mutation
plan, and the atomic completion Port must confirm durable completion before the
orchestrator acknowledges a new event. Missing mapping, missing plan/Port, and
retryable completion failure return 503. A completed duplicate remains
side-effect free and may be acknowledged.

These business rules remain deployment gates for the future AWS adapter:

- light and premium entitlement values
- immediate versus period-end cancellation
- treatment of existing rights during `INCOMPLETE`
- plan changes during update
- recurring-payment grace period
- refund and chargeback behavior

## Logging contract

Allowed: correlation ID, 64-character event digest, event type, environment,
verification outcome, replay classification, transition decision, duration,
and fixed result code.

Forbidden: raw payload, email, name, card data, signature, secret,
Authorization, raw customer/subscription/plan IDs, exception messages, and full
DynamoDB items.
