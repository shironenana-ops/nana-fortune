# Legacy API Authentication Boundary Audit

Date: 2026-08-03

## Two distinct endpoint facts

1. Browser actual references API ID `zaebx82pyf`.
2. `LEGACY_ACCOUNT` contains a different `shirone7-checkout-api` with the same
   conceptual routes.

Because the IDs differ, security evidence from the second API cannot clear or
confirm the first API's vulnerability.

## `/user/status`

### Browser actual (`zaebx82pyf`)

- client sends `user_id`;
- no Authorization header is constructed near the request;
- owner account, Gateway authorizer, Lambda and table remain unknown.

Security verdict: `P0_CANDIDATE_NOT_CLEARED`.

### Legacy-account route

- route: `GET /user/status`;
- integration: `shirone7-user-status`;
- execute-api endpoint enabled;
- Gateway authorization: NONE;
- API authorizer: absent;
- Lambda environment keys: only `USERS_TABLE_NAME`;
- Users binding: `shirone7_users`;
- IAM: `dynamodb:GetItem` on that table.

The deployed source package was not downloaded because Lambda code retrieval
would cross the prohibited object-read boundary. A hard-coded or alternative
auth mechanism therefore cannot be disproved solely from configuration.

Security verdict: `AUTH_BOUNDARY_PARTIAL`.

## `/subscription/change-plan`

### Browser actual (`zaebx82pyf`)

- client sends `user_id` and target plan;
- no Authorization header is constructed near the request;
- owner account and Lambda remain unknown.

Security verdict: `P0_CANDIDATE_NOT_CLEARED`.

### Legacy-account route

- route: `POST /subscription/change-plan`;
- integration: `shirone7-change-plan`;
- execute-api endpoint enabled;
- Gateway authorization: NONE;
- API authorizer: absent;
- environment keys contain Users, CORS and Stripe configuration only;
- no session-token configuration is present;
- IAM permits `GetItem` and `UpdateItem` on `shirone7_users`.

The deployed source was not read, so body validation, target-plan validation
and any nonstandard identity check remain unknown.

Security verdict: `CHANGE_PLAN_PARTIAL`.

## P0 decision

The strict confirmation condition requires evidence of all four:

```text
public endpoint
AND no Gateway authorizer
AND no Lambda authentication
AND arbitrary request user_id controls the record
```

For the browser-referenced API, only the first and browser input behavior are
known. For the legacy-account API, the first two and absence of standard secret
configuration are known, but deployed code was not inspected.

Therefore:

```text
P0 confirmed: 0
P0 cleared: 0
P0 candidates: user status, change plan
```

## Required next evidence

One of these approved paths is needed before a P0 decision:

- read-only profile for the account that owns `zaebx82pyf`; or
- a reviewed deployment manifest/source hash proving which Lambda package backs
  the public API; or
- separately approved source-package inspection that does not expose secrets or
  user data.

Do not perform a live status lookup or plan-change request as a security test.
