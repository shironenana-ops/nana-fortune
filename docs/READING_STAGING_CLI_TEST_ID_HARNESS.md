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

- one `boto3.Session` is fixed to the temporary least-privilege profile
  `shirone-staging-graduation` and region
  `ap-northeast-1`; all seven service clients come from that Session;
- caller account must equal `SHIRONE_STAGING_EXPECTED_ACCOUNT_ID` and caller
  must be a non-root assumed role;
- stack name/StackId/ARN, `UPDATE_COMPLETE` state, exact 32-resource logical
  ID/type inventory, physical IDs, and five Phase 1 switch values must match
  the staging contract;
- both event-source mappings must be disabled and all four queues empty;
- all six tables must be active in the expected account and Tokyo region;
- all six tables, four Lambdas, four queues/DLQs, and the HTTP API must carry
  every resource tag explicitly declared for them in the tracked staging IaC;
- CloudFormation ownership comes from the exact stack name/StackId/account/
  region and the 32-entry logical ID, resource type, and physical ID mapping;
- `aws:cloudformation:stack-id`, `stack-name`, and `logical-id` resource tags
  are supplemental evidence: absent values do not fail, but every value that
  is present must exactly match the validated stack mapping;
- the existing implementation-defined `SESSION_TOKEN_SECRET` key must be
  present and non-empty in both request and status Lambda configurations;
- the two already-resolved Lambda environment values must constant-time match;
- request/status `KMSKeyArn` must both be absent or must be the same single
  customer-managed key in the expected account and Tokyo region;
- `POST /reading` must target exactly
  `integrations/<ReadingRequestIntegration physical ID>`;
- `GET /reading/status` must target exactly
  `integrations/<ReadingStatusIntegration physical ID>`;
- integration URI, payload version, timeout, method, type, and absence of path
  rewriting must match the Phase 1 contract.

The HTTP API boundary uses one `GetApi` call with the API ID taken from the
exact CloudFormation physical-resource mapping. The same response must contain
the expected API ID, HTTP protocol, exact staging name and endpoint, and every
tag explicitly declared for `ReadingHttpApi` in the tracked template. In
particular, `Project=nana-fortune` and `Environment=staging` must match.
`GetTags` is not called and there is no tag-endpoint fallback or IAM resource.
Each of the two routes is read once with `GetRoute`, and each of the two
integrations is read once with `GetIntegration`, using only the physical IDs
from the exact CloudFormation mapping. `GetRoutes` and `GetIntegrations`
collection calls are not used and have no fallback. Route ID/key/target,
authorization type, managed state, and integration ID/type/method/URI/payload
version/timeout must all match the tracked staging contract.

`ApiGatewayManaged` is optional in the AWS response. For stack-mapped
`AWS::ApiGatewayV2::Route` and `AWS::ApiGatewayV2::Integration` resources, an
omitted key and the boolean value `false` both mean unmanaged. Boolean `true`,
`null`, strings, numbers, and every other type fail closed. This normalization
does not relax any required route or integration identity field.

SDK failures are converted to an allow-listed diagnostic containing only the
phase, exception class, HTTP status, AWS error code, and a fixed
classification. Raw exception messages, account/API/resource identifiers,
request IDs, secrets, tokens, and full responses are not printed.

Immediately before the sole conditional write, the same Session rechecks the
STS identity, stack/account/region and physical-resource inventory, exact users
table ARN/resource tags, and the request/status Lambda configuration, switches,
secret equality, and KMS boundary. Profile or credential resolution is not
restarted during execution.

Stack-level `Project`/`Environment` tags are deliberately not a prerequisite.
The tracked template applies tags to supported resources, the design plan says
that resources are tagged, and the tracked creation/change-set procedures and
history contain no stack-level `--tags` contract. Treating absent stack tags as
an error would therefore invent a boundary that the deployed design never
established. Resource-level IaC tags and the CloudFormation stack resource
mapping are the enforced evidence instead. A custom tag that is not declared
in the tracked template is not invented as a prerequisite.

## Write, token, and smoke behavior

The harness first performs a consistent `GetItem` for the fixed ID. If absent,
it performs exactly one conditional `PutItem` into `ReadingUsersTable`. The
item is `light / active` and contains a PBKDF2 password hash for a fixture
password derived in-process from the staging session secret. If a conditional
race occurs, one consistent `GetItem` follows; execution continues only when
the exact four-field item and modern password hash verify against that fixture
password. The harness never updates or deletes the item.

The session token, fixture password, and deployed Lambda secret stay in local
variables in the same Python process. Neither Secrets Manager nor a secret ARN
is used. The token is passed directly to the two bounded HTTP
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
does not import boto3, create a Session/client, or start a subprocess. The
separately approved external Python 3.12 virtual environment supplies boto3;
absence is a fail-closed prerequisite.

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
- `lambda:GetFunctionConfiguration`, `lambda:ListTags` for four staging
  Lambdas;
- `lambda:GetEventSourceMapping` for two staging mappings;
- `apigateway:GET` for one exact staging HTTP API, two exact routes, and two
  exact integrations. The HTTP API response itself supplies the tracked tags;
  collection resources, `/tags/*`, and tag-endpoint permissions are not
  granted;
- `sqs:GetQueueAttributes`, `sqs:ListQueueTags` for four staging queues;
- `dynamodb:DescribeTable` and `dynamodb:ListTagsOfResource` for six staging
  tables;
- `dynamodb:GetItem` for the fixed test user and fixed nonexistent job keys;
- `dynamodb:PutItem` for the users table only, constrained with
  `dynamodb:LeadingKeys` to the fixed staging test ID;
- `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData` for read-only
  supplemental evidence.
- `kms:Decrypt` for one exact customer-managed key only when request/status
  Lambda configurations both identify that same key; no KMS permission is
  needed when `KMSKeyArn` is absent.

Not required: Lambda Invoke, SQS Send/Receive/Delete, Bedrock Invoke,
DynamoDB Update/Delete/Scan/Query/Batch/Transaction, deploy, or any production
permission. Secrets Manager permissions are explicitly not required. No IAM
policy is created by the harness implementation itself.

## Login Lambda packaging boundary

`scripts/build_login_lambda.py` builds a fixed allow-list ZIP containing
`login.py`, `auth_security.py`, and `session_token.py`. Future login Lambda
deployment must use this builder or an equivalent fixed allow-list process;
broad globs and ad-hoc ZIP creation are not accepted. This workflow builds and
imports the ZIP locally only and does not upload it.
