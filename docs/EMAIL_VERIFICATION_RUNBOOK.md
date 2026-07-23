# Email verification runbook

Status: source implementation only.  No Lambda route, DynamoDB table, SES
identity, API Gateway route, or environment setting was changed by this work.

## Pre-deployment review

1. Create a dedicated security-state table with `security_ref` as the key and
   TTL enabled on `expires_at`.
2. Provision least-privilege roles: the signup/resend handlers need constrained
   users-table updates, token-state writes, and SES v2 `SendEmail`; verify needs
   token-state read/delete and conditional users-table update.
3. Store `EMAIL_VERIFICATION_TOKEN_SECRET` outside code, separately from the
   login-throttle HMAC secret.  Never put it in browser variables, screenshots,
   logs, or test fixtures.
4. Confirm `EMAIL_VERIFICATION_FROM_ADDRESS` is verified for the target SES
   region and that the account is out of sandbox if external recipients are
   intended.
5. Set all variables listed in `AUTH_SECURITY_CONFIGURATION.md`; otherwise the
   enabled feature fails closed.

## Safe rollout

1. Deploy handlers and routes while `EMAIL_VERIFICATION_ENABLED` is unset.
2. Run non-production smoke tests with test addresses only and a mocked/isolated
   SES delivery path.
3. Enable the flag in a controlled environment.  New accounts become pending;
   old users without `email_verified` retain access.
4. Verify a new link, an expired link, a replay, a resend rotation, a wrong
   password against a pending account, and a correct password against a pending
   account.  Only the latter may return `EMAIL_VERIFICATION_REQUIRED`.
5. Monitor generic 429/503/403 counts and SES delivery signals.  Do not log raw
   emails, verification tokens, request IDs from providers, or message bodies.

## Incident handling

- Delivery failures remove the newly-issued token state so a later resend can
  retry.  Do not manually manufacture tokens.
- A suspected secret exposure requires rotation of the corresponding secret,
  invalidation of outstanding token state, and a human incident review.
- To pause new verification without changing historical account status, unset
  `EMAIL_VERIFICATION_ENABLED`; do not mass-edit `email_verified` records.
