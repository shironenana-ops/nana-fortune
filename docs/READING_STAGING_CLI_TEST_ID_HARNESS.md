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

- password storage uses `lambda/auth_security.py::password_hash`, the same
  PBKDF2 format used by `lambda/signup.py`;
- the item has the existing users keys `user_id`, `password`, `plan`, and
  `subscription_status` only;
- token creation uses the pure signer imported by `lambda/login.py` from
  `lambda/session_token.py`;
- request payload, idempotency header, status `job_ref`, and public error codes
  come from the current request/status tests and contracts.

The fixed identity uses the reserved `.invalid` namespace and is not a real
person. Its literal value is never printed by the harness.

## Fail-closed checks before the one allowed write

- profile is fixed to `shirone-staging`, region to `ap-northeast-1`, stack to
  `nana-reading-staging`, and stage to `staging`;
- caller account must equal `SHIRONE_STAGING_EXPECTED_ACCOUNT_ID` and caller
  must be a non-root assumed role;
- stack tags must be `Project=nana-fortune` and `Environment=staging`;
- stack must be `UPDATE_COMPLETE` and the five switch values must match Phase 1;
- all required physical resources must be discovered from that stack, never by
  a guessed name;
- both event-source mappings must be disabled and all four queues empty;
- all six tables must be active in the expected account and Tokyo region;
- the fixed users key may be absent or contain only the exact approved test
  identity, and the fixed missing job key must remain absent;
- the runtime secret ARN is supplied through
  `SHIRONE_STAGING_RUNTIME_SECRET_ARN`, must belong to the expected account and
  region, contain `staging`, exclude `prod`, and carry matching project and
  environment tags;
- the retrieved `session_token_secret` must constant-time match the already
  resolved request Lambda environment value;
- API routes and integrations must retain their exact Phase 1 shape.

## Write and smoke behavior

The harness first performs a consistent `GetItem` for the fixed ID. If absent,
it performs exactly one conditional `PutItem` into `ReadingUsersTable`. The
item is `light / active` and contains a freshly generated PBKDF2 password hash.
If an item already exists, it is reused only when its exact four-field schema
matches. The harness never updates or deletes the item.

The session token and secret stay in process memory. The token is temporarily
placed in `SHIRONE_STAGING_SESSION_TOKEN` in the current process, used for one
POST and one GET, then removed in `finally`. Neither value is written to a
file, command argument, console, report, or log.

Expected responses are:

- `POST /reading`: 503 `READING_ASYNC_PAID_DISABLED`;
- `GET /reading/status`: 404 `READING_STATUS_NOT_FOUND`.

Before and after the HTTP calls, the harness compares the fixed user item, the
fixed missing job, queue attributes, and ESM states. It then
waits for CloudWatch publication and requires light/deep worker and aggregate
Bedrock invocations to remain zero. Any mismatch stops without cleanup writes.

## Local validation

```powershell
npm run test:reading-staging-cli-harness
```

This uses fake adapters only and performs no AWS or HTTP access.

## Future approved execution shape

Do not place either environment value in a command transcript or committed
file. After setting them in the current local process, the separately approved
execution command is:

```text
<python> scripts/reading_staging_cli_harness.py --execute --confirm CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE
```

## Required IAM permissions

Scope every resource permission to the exact staging resource discovered and
approved before execution.

- `sts:GetCallerIdentity`;
- `cloudformation:DescribeStacks`, `cloudformation:ListStackResources` for
  `nana-reading-staging`;
- `secretsmanager:DescribeSecret`, `secretsmanager:GetSecretValue` for the one
  tagged staging runtime secret;
- `lambda:GetFunctionConfiguration` for the four staging Lambdas;
- `lambda:GetEventSourceMapping` for the two staging mappings;
- `apigateway:GET` for the one staging HTTP API, its two routes, and two
  integrations;
- `sqs:GetQueueAttributes` for the four staging queues;
- `dynamodb:DescribeTable` for the six staging tables;
- `dynamodb:GetItem` for the fixed test user key and fixed nonexistent job key;
- `dynamodb:PutItem` for `ReadingUsersTable` only, additionally constrained to
  the fixed test partition key where the IAM policy mechanism permits it;
- `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData` for read-only
  post-smoke evidence.

No IAM permission is required for Lambda invocation, SQS send/receive/delete,
Bedrock invocation, DynamoDB update/delete/batch/transaction, deployment, or
production resources.

`dynamodb:Scan` is deliberately not required. The POST kill switch is checked
before request execution, the status request is read-only, and the harness
compares only the two fixed records plus queue, event-source-mapping, and
worker/Bedrock metrics before and after the smoke test. Broad table scans would
increase data exposure without providing a reliable operation-level audit.

The repository previously had no tracked, reproducible packaging command for
the existing Python login Lambda. `scripts/build_login_lambda.py` now builds a
fixed allow-list ZIP containing `login.py`, `auth_security.py`, and
`session_token.py`. Its regression test extracts that ZIP and imports the login
handler from the same root-level module layout used by Lambda. No package is
uploaded by this workflow.
