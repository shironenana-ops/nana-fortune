# AWS Runtime Actual Map

Date: 2026-08-03
Scope: read-only AWS and public-browser reconciliation
Repository baseline: `feat/fincode-test-payment-e2e` / `c1486eaefe95e0356cffea3dfe6e864129edf51d`

## Evidence boundary

- The only configured AWS profile is `shirone-staging` in `ap-northeast-1`.
- STS confirmed an assumed-role session in the account labelled
  `READING_STAGING_ACCOUNT`. The raw account ID and ARN are intentionally omitted.
- No profile for the account serving the legacy public membership API was
  available. Its Lambda, tables, IAM and deployed source remain `UNKNOWN`.
- DynamoDB items were not read. S3 objects, secrets and environment-variable
  maps were not read or displayed.
- The production `/members` page and its two JavaScript assets were fetched with
  unauthenticated GET only. No form, login or API request was submitted.

## AWS identity matrix

| Profile | Account label | Principal | Region | Intended environment |
| --- | --- | --- | --- | --- |
| `shirone-staging` | `READING_STAGING_ACCOUNT` | assumed role | `ap-northeast-1` | reading staging |
| legacy profile | unavailable | unknown | expected `ap-northeast-1` | current public membership/voice runtime |

## Browser actual

The deployed `/members` page still loads both of these references:

- `zaebx82pyf.../user/status`
- `zaebx82pyf.../subscription/change-plan`

The deployed JavaScript context contains `user_id` but no `Authorization` near
either request. This establishes the browser-side contract only. It does not
prove that the target Lambda lacks a separate ownership check.

The API ID `zaebx82pyf` was absent from both API Gateway v1 and v2 in
`READING_STAGING_ACCOUNT`. Its owner is therefore not this staging account.

| Boundary question | AWS/browser actual | Verdict |
| --- | --- | --- |
| Browser sends Authorization to `/user/status` | no | confirmed |
| Browser sends `user_id` | yes | confirmed |
| API Gateway authorizer | target account unavailable | unknown |
| Lambda verifies identity/ownership | target account unavailable | unknown |
| Lambda trusts client `user_id` | target account unavailable | unknown |
| IDOR is proven | no | `P0_CANDIDATE_NOT_CLEARED` |

## Reading staging stack

- Stack: `nana-reading-staging`
- Status: `UPDATE_COMPLETE`
- Current resource count: 32
- Creation: 2026-07-27
- Last update: 2026-07-28
- Stack-reported drift state at read time: `NOT_CHECKED`

The account also contains three older deleted generations of the same stack and
six deleted temporary graduation-role stacks. Duplicate physical DynamoDB
tables remain for six logical table purposes. The current stack mapping below,
not name similarity, is the runtime authority.

## Logical to physical map

| Logical ID | Physical ID | Account label | Region | Status |
| --- | --- | --- | --- | --- |
| `ReadingUsersTable` | `nana-reading-staging-ReadingUsersTable-DU5Q5CNTDLIJ` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `ReadingHistoryTable` | `nana-reading-staging-ReadingHistoryTable-YHTE1U9MZZAR` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `ReadingIdempotencyTable` | `nana-reading-staging-ReadingIdempotencyTable-173STKUH0KY6T` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `ReadingRateLimitTable` | `nana-reading-staging-ReadingRateLimitTable-1WO0DPKP823GH` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `ReadingDeepQuotaTable` | `nana-reading-staging-ReadingDeepQuotaTable-VF0FRYJXQI0A` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `ReadingJobsTable` | `nana-reading-staging-ReadingJobsTable-WIFU5E0R3WWK` | READING_STAGING_ACCOUNT | ap-northeast-1 | ACTIVE |
| `FincodeLightQuotaTable` | not deployed | - | - | NOT_DEPLOYED |
| `FincodeWebhookLedgerTable` | not deployed | - | - | NOT_DEPLOYED |
| `FincodeCustomerMappingTable` | not deployed | - | - | NOT_DEPLOYED |
| `ReadingRequestFunction` | `nana-reading-staging-reading-request` | READING_STAGING_ACCOUNT | ap-northeast-1 | deployed |
| `ReadingStatusFunction` | `nana-reading-staging-reading-status` | READING_STAGING_ACCOUNT | ap-northeast-1 | deployed |
| `LightWorkerFunction` | `nana-reading-staging-reading-light-worker` | READING_STAGING_ACCOUNT | ap-northeast-1 | deployed |
| `DeepWorkerFunction` | `nana-reading-staging-reading-deep-worker` | READING_STAGING_ACCOUNT | ap-northeast-1 | deployed |
| `FincodeWebhookFunction` | not deployed | - | - | NOT_DEPLOYED |
| `ReadingHttpApi` | API ID recorded in CloudFormation | READING_STAGING_ACCOUNT | ap-northeast-1 | deployed |
| `FincodeWebhookHttpApi` | not deployed | - | - | NOT_DEPLOYED |

All five deployed DynamoDB data tables except `ReadingJobsTable` have PITR
enabled. Deletion protection is enabled on all six current tables.
`ReadingJobsTable` PITR is disabled.

## Runtime bindings

| Lambda | Users | History | Jobs | Light quota | Deep quota |
| --- | --- | --- | --- | --- | --- |
| request | current ReadingUsers | current ReadingHistory | current ReadingJobs | absent | current ReadingDeepQuota |
| status | none | current ReadingHistory | current ReadingJobs | absent | none |
| light worker | none | current ReadingHistory | current ReadingJobs | absent | none |
| deep worker | current ReadingUsers | current ReadingHistory | current ReadingJobs | absent | current ReadingDeepQuota |

The missing Light quota binding is safe only because paid async execution is
disabled. Enabling paid Light now would fail closed rather than provide the
catalogued entitlement.

## Feature flags and event sources

| Control | AWS actual |
| --- | --- |
| `READING_GENERATE_API_ENABLED` | true |
| `READING_STATUS_API_ENABLED` | true |
| `READING_ASYNC_PAID_ENABLED` | false |
| `READING_BEDROCK_ENABLED` | false on both workers |
| `READING_LIGHT_QUOTA_ENABLED` | not deployed |
| `FINCODE_WEBHOOK_ENABLED` | not deployed |
| `FINCODE_PERIOD_SOURCE_ENABLED` | not deployed |
| Light worker event-source mapping | Disabled |
| Deep worker event-source mapping | Disabled |

Both HTTP API routes use `AuthorizationType=NONE` at API Gateway. Authentication
is therefore a Lambda responsibility in this architecture. Source implements a
Bearer-token boundary, but this audit did not submit tokens or invoke the APIs.

## IAM and cross-account evidence

The four deployed Lambda roles:

- trust only `lambda.amazonaws.com`;
- contain no wildcard Action;
- contain no `Resource: "*"` in their inline runtime statements;
- contain no resource ARN from another account;
- contain no `sts:AssumeRole` action.

Result for deployed reading staging:

```text
NO_CROSS_ACCOUNT_RUNTIME_DEPENDENCY
```

This is not evidence that the overall service is single-account. The deployed
public membership API demonstrably resides outside this staging account and no
bridge exists in the reading roles.

## Legacy runtime map

| Component | Actual |
| --- | --- |
| `zaebx82pyf` owner | not READING_STAGING_ACCOUNT; exact owner unknown |
| `/user/status` Lambda/auth/table | unknown without legacy profile |
| `/subscription/change-plan` Lambda/auth/table | unknown without legacy profile |
| login Users table | source default `shirone7_users`; AWS actual unknown |
| Voice Users table | source default `shirone7_users`; AWS actual unknown |
| Voice History table | source default `shirone7_history`; AWS actual unknown |
| Voice bucket and events | AWS actual unknown |
| related staging S3 | artifact bucket only; no legacy Voice bucket identified |

## Mutation statement

AWS mutation: 0. DynamoDB item read: 0. S3 object read/write: 0. Secret value
read: 0. fincode request: 0. production API submission: 0.
