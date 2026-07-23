# Authentication security configuration

This document describes source-level configuration only.  It does not authorize
deployment or creation of AWS resources.

## Password storage

New passwords use `pbkdf2_sha256$600000$<salt>$<hash>` with a random 16-byte
or longer salt and a 32-byte derived key.  The server accepts passwords of 8 to
128 characters and at most 256 UTF-8 bytes.  A successful login of an existing
strict 64-character SHA-256 record attempts a conditional in-place upgrade; a
wrong password, malformed value, or already-modern value is never rewritten.

## Login throttle (disabled by default)

Set `AUTH_SECURITY_ENABLED=true` only after all of the following are supplied:

| Variable | Required value |
| --- | --- |
| `AUTH_SECURITY_TABLE_NAME` | Dedicated DynamoDB table for auth security state |
| `AUTH_SECURITY_HASH_SECRET` | High-entropy secret, stored outside source control |
| `AUTH_ACCOUNT_FAILURE_LIMIT` | Candidate: `5` |
| `AUTH_ACCOUNT_WINDOW_SECONDS` | Candidate: `900` |
| `AUTH_ACCOUNT_LOCK_SECONDS` | Candidate: `900` |
| `AUTH_IP_FAILURE_LIMIT` | Candidate: `20` |
| `AUTH_IP_WINDOW_SECONDS` | Candidate: `900` |

The source derives account and source-IP keys with domain-separated HMAC-SHA256.
It uses `requestContext.http.sourceIp` for HTTP API v2 (or the legacy API
Gateway identity field), not a client supplied forwarding header.  Missing or
invalid enabled configuration, or state-store failure, is a fail-closed generic
`503`; lock/rate denials are generic `429` with an integer `Retry-After`.

The DynamoDB table must use `security_ref` as its partition key and enable TTL
on `expires_at`.  It should have no publicly accessible read path.  Do not put
raw email addresses, raw IP addresses, passwords, session tokens, or hash
secrets into keys, application logs, browser telemetry, or evidence files.

## Email verification (disabled by default)

`EMAIL_VERIFICATION_ENABLED=true` requires:

| Variable | Purpose |
| --- | --- |
| `AUTH_SECURITY_TABLE_NAME` | Same dedicated security-state table |
| `EMAIL_VERIFICATION_TOKEN_SECRET` | HMAC secret distinct from the throttle secret |
| `EMAIL_VERIFICATION_FROM_ADDRESS` | Verified SES sender address |
| `EMAIL_VERIFICATION_BASE_URL` | HTTPS public base URL only, without query/fragment |
| `AWS_REGION` | SES v2 region |
| `EMAIL_VERIFICATION_RESEND_SECONDS` | Integer resend interval, e.g. `60` |
| `EMAIL_VERIFICATION_TTL_SECONDS` | Integer token lifetime, candidate `86400` |

New accounts are then created with `email_verified=false`.  Existing records
without this attribute remain verified for compatibility.  A token contains 256
bits of random secret material; only an HMAC digest and opaque reference are
stored.  Tokens expire, are single-use, and rotation changes the user-side
reference so an older link can no longer verify the account.

Before enabling either flag, create least-privilege DynamoDB and SES policies,
configure TTL, add metric/alarm ownership, run an isolated staging test, and
have a human review secrets, CORS, sender identity, and retention settings.
