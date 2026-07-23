# fincode security-form evidence — 2026-07-23

Scope: local source audit and implementation evidence.  This is not a fincode
submission, merchant attestation, production test, or legal/security guarantee.

| Form topic | Status | Local evidence / required human confirmation |
| --- | --- | --- |
| Management-account two-factor authentication | `MANUAL_CONFIRMATION_REQUIRED` | No management-console configuration was accessed. Confirm directly in fincode/MOSH administration. |
| User audio uploads | `VERIFIED_IN_SOURCE` | `lambda/voice_upload.py` defines a 20 MiB limit and an explicit extension allowlist. Production API Gateway/WAF enforcement still needs separate confirmation. |
| Dependency vulnerability remediation | `PARTIAL` | `npm audit --omit=dev` reported 9 production dependency advisories (6 high, 2 moderate, 1 low). No automatic update was performed because the offered fixes include breaking upgrades; dependency reachability/remediation remains an ongoing operational task. |
| Endpoint malware / Defender | `MANUAL_CONFIRMATION_REQUIRED` | Local source cannot attest endpoint protection state. |
| Credit-card master-data handling | `SHARED_RESPONSIBILITY` | fincode handles payment processing; White Sound Seven must still protect its own account, authentication, logging, and access controls. |
| Login hardening | `IMPLEMENTED_NOT_ENABLED` | PBKDF2 storage, lazy legacy upgrade, HMAC-keyed throttle, and generic failure behavior are source implemented behind disabled flags. |
| Email verification | `IMPLEMENTED_NOT_ENABLED` | Opaque 256-bit token, digest storage, expiry/single-use, resend rotation, and SES v2 adapter are source implemented behind a disabled flag. |
| EMV 3-D Secure | `SHARED_RESPONSIBILITY / NOT_IMPLEMENTED` | No fincode 3DS configuration was changed. Merchant-side contract/configuration and customer-flow requirements require human confirmation. |

## Attribute-change flow audit

`ATTRIBUTE_CHANGE_FLOW: NOT_APPLICABLE_CURRENTLY`

This repository audit found no current backend endpoint that changes a member's
registered email address.  If such a flow is introduced, it must require recent
authentication, issue a new verification token for the new address, protect the
change with conditional state, and retain an audit trail without raw secrets.

## Implementation boundaries

- No AWS, SES, fincode, MOSH, API Gateway, or browser security-form request was
  made for this evidence.
- No production flag was enabled and no secret value was read, printed, stored,
  or committed.
- The frontend verification page is `noindex`; it never displays the raw token
  and uses text-only status updates.
