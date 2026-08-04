# Legacy AWS Runtime Actual Map

Date: 2026-08-03
Profile: `nana-legacy-readonly`
Account label: `LEGACY_ACCOUNT`
Region: `ap-northeast-1`

## Evidence boundary

- The profile resolves to an assumed role in an account different from
  `READING_STAGING_ACCOUNT`.
- Raw account IDs and ARNs are intentionally omitted.
- No DynamoDB item, S3 object, secret value or deployed Lambda package was read.
- No production API request was sent.

## Public API ownership result

The API ID hard-coded in the deployed public members bundle, `zaebx82pyf`, was
not found in API Gateway v1 or v2 in either known account:

- not in `READING_STAGING_ACCOUNT`;
- not in `LEGACY_ACCOUNT`.

Verdict:

```text
ZAEBX_NOT_FOUND_IN_KNOWN_ACCOUNTS
PUBLIC_API_OWNER_UNKNOWN
```

`LEGACY_ACCOUNT` does contain a different HTTP API named
`shirone7-checkout-api` with equivalent `/user/status` and
`/subscription/change-plan` routes. It must not be treated as the public API
without matching the API ID or an approved endpoint check.

## Legacy APIs

| API | Stage | Route | Integration | Gateway auth |
| --- | --- | --- | --- | --- |
| `shirone7-api` | `$default` | `POST /signup` | `shirone7-signup` | NONE |
| `shirone7-api` | `$default` | `POST /login` | `shirone7-login` | NONE |
| `shirone7-api` | `$default` | `POST /voice/upload` | `shirone7-voice-upload` | NONE |
| `shirone7-checkout-api` | `$default` | `GET /user/status` | `shirone7-user-status` | NONE |
| `shirone7-checkout-api` | `$default` | `POST /subscription/change-plan` | `shirone7-change-plan` | NONE |
| `shirone7-history-api` | `prod` | history CRUD routes | history Lambdas | NONE |

All three execute-api endpoints are enabled. They were not invoked in this
audit.

## Lambda bindings

| Responsibility | Function | Runtime | Users | History | Bucket | Auth configuration |
| --- | --- | --- | --- | --- | --- | --- |
| signup | `shirone7-signup` | Python 3.14 | `shirone7_users` | - | - | public registration |
| login | `shirone7-login` | Python 3.14 | `shirone7_users` | - | - | session secret present |
| user status | `shirone7-user-status` | Python 3.14 | `shirone7_users` | - | - | no session-secret env; Gateway NONE |
| change plan | `shirone7-change-plan` | Python 3.14 | `shirone7_users` | - | - | no session-secret env; Gateway NONE |
| Voice upload | `shirone7-voice-upload` | Python 3.14 | `shirone7_users` | `shirone7_history` | `shirone7-voice-poc-001` | session secret present |
| Voice result | `shirone7-voice-result` | Python 3.14 | `shirone7_users` | `shirone7_history` | `shirone7-voice-poc-001` | event-driven |
| old Voice PoC | `shirone7-voice-poc` | Python 3.12 | unknown | `shirone7_history` | `shirone7-voice-poc-001` | event-driven |
| history save/list/detail/delete | dedicated Lambdas | Python 3.14 | - | `shirone7_history` | detail can read Voice bucket | session secret present |

The environment-key evidence for status is only `USERS_TABLE_NAME`. Change-plan
has Users, CORS and Stripe settings, but no session-token setting.

## DynamoDB actual

| Table | Keys | Billing | PITR | Deletion protection | Tags |
| --- | --- | --- | --- | --- | --- |
| `shirone7_users` | `user_id` | PAY_PER_REQUEST | disabled | false | none |
| `shirone7_history` | `user_id`, `history_id` | PAY_PER_REQUEST | disabled | false | none |

No item was read, so the distribution of legacy membership schemas and the
number of records requiring membership-v1 migration remain unknown.

## S3 actual

The Voice bucket is `shirone7-voice-poc-001` in `ap-northeast-1`.

- bucket policy status is not public;
- no tag set exists;
- no object was listed or read;
- `raw/` object creation invokes `shirone7-voice-poc`;
- `transcript/member/*.json` object creation invokes
  `shirone7-voice-result`;
- no Lambda event-source mapping exists for Voice result because S3 invokes it
  through bucket notification.

## IAM boundary

Audited login, status, change-plan, Voice and history roles trust the Lambda
service and reference same-account tables/bucket. No cross-account resource ARN
or `sts:AssumeRole` dependency was found.

```text
LEGACY_ACCOUNT_SELF_CONTAINED_FOR_AUDITED_RUNTIME
```

Operational findings:

- Voice upload uses Resource `*` for Transcribe start/get actions.
- Voice result uses Resource `*` for Bedrock and Marketplace actions.
- Voice result can `dynamodb:Scan` the History table.
- a history-list role retains a second target spelling, `shirone7-history`, in
  addition to the actual `shirone7_history` table.

## Mutation statement

AWS mutation: 0. DynamoDB item read: 0. S3 object read: 0. Secret value read:
0. production API request: 0. deploy: 0.
