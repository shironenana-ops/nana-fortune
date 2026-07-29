# Reading staging CLI test-ID harness

## Purpose and boundary

`scripts/reading_staging_cli_harness.py` prepares one fixed, non-personal
staging identity and performs the already-approved Phase 1 API smoke in the
same Python process. It does not deploy API Gateway or Lambda, connect to
production, or persist a session token.

The command is inert by default. AWS writes and HTTP requests require both
`--execute` and the exact confirmation phrase. The first approved AWS run is a
separate operation; implementation and local tests do not execute it.

## Reused contracts

- password storage and verification use `lambda/auth_security.py`;
- the item has the existing users keys `user_id`, `password`, `plan`, and
  `subscription_status` only;
- token creation uses the pure signer imported by `lambda/login.py` from
  `lambda/session_token.py`;
- request payload, idempotency header, status `job_ref`, and public error codes
  come from the current request/status tests and contracts.

The fixed identity uses the reserved `.invalid` namespace and is not a real
person. Its literal value is never printed by the harness.

## Fail-closed checks before the one allowed write

- one `boto3.Session` is fixed to profile `shirone-staging` and region
  `ap-northeast-1`; all eight service clients come from that Session;
- caller account must equal `SHIRONE_STAGING_EXPECTED_ACCOUNT_ID` and caller
  must be a non-root assumed role;
- stack name/StackId/ARN, `UPDATE_COMPLETE` state, exact 32-resource logical
  ID/type inventory, physical IDs, and five Phase 1 switch values must match
  the staging contract;
- both event-source mappings must be disabled and all four queues empty;
- all six tables must be active in the expected account and Tokyo region;
- the users table, four Lambdas, four queues/DLQs, and HTTP API must carry
  `Project=nana-fortune`, `Environment=staging`, and exact
  `aws:cloudformation:stack-id`, `stack-name`, and `logical-id` resource tags;
- the runtime secret ARN must match the expected account, region, staging name,
  and project/environment tags;
- the retrieved `session_token_secret` must constant-time match the already
  resolved request and status Lambda environment values;
- `POST /reading` must target exactly
  `integrations/<ReadingRequestIntegration physical ID>`;
- `GET /reading/status` must target exactly
  `integrations/<ReadingStatusIntegration physical ID>`;
- integration URI, payload version, timeout, method, type, and absence of path
  rewriting must match the Phase 1 contract.

Immediately before the sole conditional write, the same Session rechecks the
STS identity, stack/account/region and physical-resource inventory, exact users
table ARN/resource tags, and exact secret ARN/tags. Profile or credential
resolution is not restarted during execution.

Stack-level `Project`/`Environment` tags are deliberately not a prerequisite.
The tracked template applies tags to supported resources, the design plan says
that resources are tagged, and the tracked creation/change-set procedures and
history contain no stack-level `--tags` contract. Treating absent stack tags as
an error would therefore invent a boundary that the deployed design never
established. Resource-level tags and CloudFormation ownership tags are the
enforced evidence instead.

## Write, token, and smoke behavior

The harness first performs a consistent `GetItem` for the fixed ID. If absent,
it performs exactly one conditional `PutItem` into `ReadingUsersTable`. The
item is `light / active` and contains a PBKDF2 password hash for a fixture
password derived in-process from the staging session secret. If a conditional
race occurs, one consistent `GetItem` follows; execution continues only when
the exact four-field item and modern password hash verify against that fixture
password. The harness never updates or deletes the item.

The session token, fixture password, and secret stay in local variables in the
same Python process. The token is passed directly to the two bounded HTTP
requests and is never placed in an environment variable or child process.
Redirects are refused, so the Authorization header cannot be forwarded to
another host. None of these values is written to a file, command argument,
console, report, or log. Clearing Python references in `finally` limits their
lifetime but does **not** guarantee cryptographic erasure of immutable strings
from process memory.

Expected responses are:

- `POST /reading`: 503 `READING_ASYNC_PAID_DISABLED`;
- `GET /reading/status`: 404 `READING_STATUS_NOT_FOUND`.

Before and after the HTTP calls, the harness compares the fixed user item, the
fixed missing job, queue attributes, and ESM states. The fixed staging user is
intentionally retained for repeatable tests. Cleanup is a destructive,
human-approved separate procedure; this harness has no delete capability.

## Worker and Bedrock evidence

ESM `Disabled`, Bedrock switch `false`, empty queues, and unchanged before/after
state are the primary evidence that worker and Bedrock paths were unreachable.
CloudWatch is supplemental evidence and never replaces these guards.

The harness records the exact smoke start and finish times, then polls for no
more than 300 seconds at 30-second intervals. `ZERO_CONFIRMED` requires an
actual completed metric result containing zero-valued data. Empty Lambda
datapoints or empty Bedrock MetricData values are `NO_DATA`, not zero. A
nonzero value stops immediately; `NO_DATA` remaining at the deadline also
fails closed. No earlier fixed window is treated as evidence for this run.

## Local validation and execution prerequisite

```powershell
npm run test:reading-staging-cli-harness
```

Local tests inject SDK-shaped fakes and perform no AWS or HTTP access. Dry-run
does not import boto3, create a Session/client, or start a subprocess. The local
Python interpreter used during implementation did not already contain boto3,
so no package was downloaded. A separately approved AWS run must use an
existing runtime that provides boto3; absence is a fail-closed prerequisite.

After the two non-secret boundary variables are set only in the current local
process, the separately approved execution shape is:

```text
<python> scripts/reading_staging_cli_harness.py --execute --confirm CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE
```

## IAM permissions for later review

Scope resource permissions to the exact staging resources discovered and
approved before execution.

- caller identity is rechecked, but `sts:GetCallerIdentity` does not require an
  explicit identity-policy Allow;
- `cloudformation:DescribeStacks`, `cloudformation:ListStackResources` for the
  one staging stack;
- `secretsmanager:DescribeSecret`, `secretsmanager:GetSecretValue` for one
  tagged staging runtime secret;
- `lambda:GetFunctionConfiguration`, `lambda:ListTags` for four staging
  Lambdas;
- `lambda:GetEventSourceMapping` for two staging mappings;
- `apigateway:GET` for one staging HTTP API, its tags, two routes, and two
  integrations;
- `sqs:GetQueueAttributes`, `sqs:ListQueueTags` for four staging queues;
- `dynamodb:DescribeTable` for six staging tables and
  `dynamodb:ListTagsOfResource` for the users table;
- `dynamodb:GetItem` for the fixed test user and fixed nonexistent job keys;
- `dynamodb:PutItem` for the users table only, constrained with
  `dynamodb:LeadingKeys` to the fixed staging test ID;
- `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData` for read-only
  supplemental evidence.

Not required: Lambda Invoke, SQS Send/Receive/Delete, Bedrock Invoke,
DynamoDB Update/Delete/Scan/Query/Batch/Transaction, deploy, or any production
permission. No IAM policy is created by this work.

## Login Lambda packaging boundary

`scripts/build_login_lambda.py` builds a fixed allow-list ZIP containing
`login.py`, `auth_security.py`, and `session_token.py`. Future login Lambda
deployment must use this builder or an equivalent fixed allow-list process;
broad globs and ad-hoc ZIP creation are not accepted. This workflow builds and
imports the ZIP locally only and does not upload it.
