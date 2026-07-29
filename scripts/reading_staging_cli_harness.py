"""Fail-closed staging test-ID preparation and Phase 1 API smoke harness.

This command is intentionally inert unless both --execute and the exact
confirmation phrase are supplied. Secret values and session tokens stay in
this Python process and are never written or printed.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
STACK_NAME = "nana-reading-staging"
STAGE_NAME = "staging"
TEST_USER_ID = "reading-light-smoke@staging.invalid"
MISSING_JOB_REF = "11111111-1111-4111-8111-111111111111"
CONFIRMATION = "CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE"
EXPECTED_PARAMETERS = {
    "ReadingGenerateApiEnabled": "true",
    "ReadingStatusApiEnabled": "true",
    "ReadingAsyncPaidEnabled": "false",
    "ReadingBedrockEnabled": "false",
    "WorkerEventSourceMappingsEnabled": "false",
}
REQUIRED_RESOURCES = {
    "ReadingUsersTable",
    "ReadingHistoryTable",
    "ReadingIdempotencyTable",
    "ReadingRateLimitTable",
    "ReadingDeepQuotaTable",
    "ReadingJobsTable",
    "LightQueue",
    "DeepQueue",
    "LightDeadLetterQueue",
    "DeepDeadLetterQueue",
    "LightEventSourceMapping",
    "DeepEventSourceMapping",
    "ReadingRequestFunction",
    "ReadingStatusFunction",
    "LightWorkerFunction",
    "DeepWorkerFunction",
    "ReadingHttpApi",
    "ReadingRequestIntegration",
    "ReadingStatusIntegration",
}
TABLE_LOGICAL_IDS = (
    "ReadingUsersTable",
    "ReadingHistoryTable",
    "ReadingIdempotencyTable",
    "ReadingRateLimitTable",
    "ReadingDeepQuotaTable",
    "ReadingJobsTable",
)


class HarnessError(RuntimeError):
    """A fixed, non-sensitive harness failure."""


@dataclass(frozen=True)
class HarnessConfig:
    expected_account_id: str
    runtime_secret_arn: str


def _lambda_imports() -> tuple[Any, Any]:
    lambda_dir = Path(__file__).resolve().parents[1] / "lambda"
    if str(lambda_dir) not in sys.path:
        sys.path.insert(0, str(lambda_dir))
    from auth_security import password_hash  # type: ignore
    from session_token import create_session_token  # type: ignore

    return password_hash, create_session_token


def load_config(env: Mapping[str, str]) -> HarnessConfig:
    account = env.get("SHIRONE_STAGING_EXPECTED_ACCOUNT_ID", "")
    secret_arn = env.get("SHIRONE_STAGING_RUNTIME_SECRET_ARN", "")
    if not re.fullmatch(r"[0-9]{12}", account):
        raise HarnessError("expected staging account is not configured")
    pattern = rf"arn:aws:secretsmanager:{re.escape(REGION)}:{account}:secret:[A-Za-z0-9/_+=.@-]+"
    if not re.fullmatch(pattern, secret_arn) or "staging" not in secret_arn.lower() or "prod" in secret_arn.lower():
        raise HarnessError("runtime secret ARN is outside the staging boundary")
    return HarnessConfig(account, secret_arn)


class AwsCliBackend:
    def __init__(self, config: HarnessConfig):
        self.config = config
        self.resources: dict[str, dict[str, Any]] = {}
        self._put_count = 0

    def _call(self, service: str, operation: str, *arguments: str) -> dict[str, Any]:
        command = [
            "aws.exe" if os.name == "nt" else "aws",
            service,
            operation,
            *arguments,
            "--profile",
            PROFILE,
            "--region",
            REGION,
            "--no-cli-pager",
            "--output",
            "json",
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"},
            check=False,
        )
        if result.returncode != 0:
            raise HarnessError(f"AWS operation failed: {service}/{operation}")
        try:
            value = json.loads(result.stdout or "{}")
        except json.JSONDecodeError as error:
            raise HarnessError(f"AWS response was invalid: {service}/{operation}") from error
        if not isinstance(value, dict):
            raise HarnessError(f"AWS response shape was invalid: {service}/{operation}")
        return value

    def _resource(self, logical_id: str) -> dict[str, Any]:
        value = self.resources.get(logical_id)
        if not value:
            raise HarnessError("required staging resource is missing")
        return value

    def validate_boundary(self) -> dict[str, Any]:
        identity = self._call("sts", "get-caller-identity")
        arn = identity.get("Arn", "")
        if identity.get("Account") != self.config.expected_account_id or ":assumed-role/" not in arn or arn.endswith(":root"):
            raise HarnessError("AWS identity is outside the staging boundary")
        stack = self._call("cloudformation", "describe-stacks", "--stack-name", STACK_NAME).get("Stacks", [])
        if len(stack) != 1 or stack[0].get("StackStatus") != "UPDATE_COMPLETE":
            raise HarnessError("staging stack is not ready")
        tags = {item.get("Key"): item.get("Value") for item in stack[0].get("Tags", [])}
        if tags.get("Environment") != STAGE_NAME or tags.get("Project") != "nana-fortune":
            raise HarnessError("staging stack tags are invalid")
        parameters = {item.get("ParameterKey"): item.get("ParameterValue") for item in stack[0].get("Parameters", [])}
        if any(parameters.get(key) != value for key, value in EXPECTED_PARAMETERS.items()):
            raise HarnessError("staging safety switches are invalid")
        summaries = self._call("cloudformation", "list-stack-resources", "--stack-name", STACK_NAME).get("StackResourceSummaries", [])
        self.resources = {item.get("LogicalResourceId"): item for item in summaries if isinstance(item, dict)}
        if not REQUIRED_RESOURCES.issubset(self.resources):
            raise HarnessError("staging resource inventory is incomplete")
        return parameters

    def validate_secret_and_get_session_secret(self) -> str:
        description = self._call("secretsmanager", "describe-secret", "--secret-id", self.config.runtime_secret_arn)
        tags = {item.get("Key"): item.get("Value") for item in description.get("Tags", [])}
        if tags.get("Environment") != STAGE_NAME or tags.get("Project") != "nana-fortune":
            raise HarnessError("runtime secret tags are outside the staging boundary")
        secret_response = self._call("secretsmanager", "get-secret-value", "--secret-id", self.config.runtime_secret_arn)
        try:
            secret_document = json.loads(secret_response.get("SecretString", ""))
        except json.JSONDecodeError as error:
            raise HarnessError("runtime secret document is invalid") from error
        session_secret = secret_document.get("session_token_secret") if isinstance(secret_document, dict) else None
        if not isinstance(session_secret, str) or len(session_secret) < 32:
            raise HarnessError("runtime session secret is invalid")
        request_name = self._resource("ReadingRequestFunction")["PhysicalResourceId"]
        configuration = self._call("lambda", "get-function-configuration", "--function-name", request_name)
        deployed_secret = configuration.get("Environment", {}).get("Variables", {}).get("SESSION_TOKEN_SECRET")
        if not isinstance(deployed_secret, str) or not hmac.compare_digest(session_secret, deployed_secret):
            raise HarnessError("runtime secret does not match the staging request Lambda")
        return session_secret

    def validate_runtime(self) -> dict[str, Any]:
        function_configurations: dict[str, dict[str, Any]] = {}
        for logical_id in ("ReadingRequestFunction", "ReadingStatusFunction", "LightWorkerFunction", "DeepWorkerFunction"):
            configuration = self._call(
                "lambda",
                "get-function-configuration",
                "--function-name",
                self._resource(logical_id)["PhysicalResourceId"],
            )
            if configuration.get("State") != "Active" or configuration.get("LastUpdateStatus") != "Successful":
                raise HarnessError("staging Lambda is not ready")
            function_configurations[logical_id] = configuration
        request_env = function_configurations["ReadingRequestFunction"].get("Environment", {}).get("Variables", {})
        status_env = function_configurations["ReadingStatusFunction"].get("Environment", {}).get("Variables", {})
        if request_env.get("READING_GENERATE_API_ENABLED") != "true" or request_env.get("READING_ASYNC_PAID_ENABLED") != "false":
            raise HarnessError("request Lambda switches are invalid")
        if status_env.get("READING_STATUS_API_ENABLED") != "true":
            raise HarnessError("status Lambda switch is invalid")
        for logical_id in ("LightWorkerFunction", "DeepWorkerFunction"):
            worker_env = function_configurations[logical_id].get("Environment", {}).get("Variables", {})
            if worker_env.get("READING_BEDROCK_ENABLED") != "false":
                raise HarnessError("worker Bedrock switch is enabled")
        for logical_id in ("LightEventSourceMapping", "DeepEventSourceMapping"):
            value = self._call("lambda", "get-event-source-mapping", "--uuid", self._resource(logical_id)["PhysicalResourceId"])
            if value.get("State") != "Disabled":
                raise HarnessError("worker event source mapping is enabled")
        for logical_id in ("LightQueue", "DeepQueue", "LightDeadLetterQueue", "DeepDeadLetterQueue"):
            value = self._call(
                "sqs",
                "get-queue-attributes",
                "--queue-url",
                self._resource(logical_id)["PhysicalResourceId"],
                "--attribute-names",
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ).get("Attributes", {})
            if any(int(value.get(key, "0")) != 0 for key in ("ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed")):
                raise HarnessError("staging queue is not empty")
        for logical_id in TABLE_LOGICAL_IDS:
            table_name = self._resource(logical_id)["PhysicalResourceId"]
            table = self._call("dynamodb", "describe-table", "--table-name", table_name).get("Table", {})
            arn = table.get("TableArn", "")
            expected_prefix = f"arn:aws:dynamodb:{REGION}:{self.config.expected_account_id}:table/"
            if table.get("TableStatus") != "ACTIVE" or not arn.startswith(expected_prefix):
                raise HarnessError("DynamoDB table is outside the staging boundary")
        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        routes = self._call("apigatewayv2", "get-routes", "--api-id", api_id).get("Items", [])
        if sorted(item.get("RouteKey") for item in routes) != ["GET /reading/status", "POST /reading"]:
            raise HarnessError("staging API routes are invalid")
        integrations: dict[str, Any] = {}
        for logical_id, function_logical_id, expected_timeout in (
            ("ReadingRequestIntegration", "ReadingRequestFunction", 29000),
            ("ReadingStatusIntegration", "ReadingStatusFunction", 10000),
        ):
            value = self._call(
                "apigatewayv2",
                "get-integration",
                "--api-id",
                api_id,
                "--integration-id",
                self._resource(logical_id)["PhysicalResourceId"],
            )
            if (
                value.get("PayloadFormatVersion") != "2.0"
                or value.get("TimeoutInMillis") != expected_timeout
                or value.get("RequestParameters")
                or value.get("IntegrationUri") != function_configurations[function_logical_id].get("FunctionArn")
            ):
                raise HarnessError("staging API integration is invalid")
            integrations[logical_id] = value
        return {"parameters": dict(EXPECTED_PARAMETERS), "integrations": integrations}

    def _table_name(self, logical_id: str) -> str:
        return self._resource(logical_id)["PhysicalResourceId"]

    def get_item(self, logical_id: str, key: dict[str, Any]) -> dict[str, Any] | None:
        value = self._call(
            "dynamodb",
            "get-item",
            "--table-name",
            self._table_name(logical_id),
            "--key",
            json.dumps(key, separators=(",", ":")),
            "--consistent-read",
        )
        item = value.get("Item")
        return item if isinstance(item, dict) else None

    def put_test_user(self, item: dict[str, Any]) -> None:
        if self._put_count != 0 or item.get("user_id") != {"S": TEST_USER_ID}:
            raise HarnessError("test user write scope was exceeded")
        self._call(
            "dynamodb",
            "put-item",
            "--table-name",
            self._table_name("ReadingUsersTable"),
            "--item",
            json.dumps(item, separators=(",", ":")),
            "--condition-expression",
            "attribute_not_exists(user_id)",
        )
        self._put_count += 1

    def side_effect_state(self) -> dict[str, Any]:
        queue_state: dict[str, Any] = {}
        for logical_id in ("LightQueue", "DeepQueue", "LightDeadLetterQueue", "DeepDeadLetterQueue"):
            queue_state[logical_id] = self._call(
                "sqs",
                "get-queue-attributes",
                "--queue-url",
                self._resource(logical_id)["PhysicalResourceId"],
                "--attribute-names",
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ).get("Attributes", {})
        esm_state = {
            logical_id: self._call("lambda", "get-event-source-mapping", "--uuid", self._resource(logical_id)["PhysicalResourceId"]).get("State")
            for logical_id in ("LightEventSourceMapping", "DeepEventSourceMapping")
        }
        return {
            "queues": queue_state,
            "esm": esm_state,
            "test_user": self.get_item("ReadingUsersTable", {"user_id": {"S": TEST_USER_ID}}),
            "missing_job": self.get_item("ReadingJobsTable", {"job_ref": {"S": MISSING_JOB_REF}}),
        }

    def validate_no_worker_or_bedrock_invocations(self, started_at: float) -> None:
        # CloudWatch metrics are delayed; wait inside this process without
        # retaining request data or credentials anywhere else.
        time.sleep(75)
        start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at - 60))
        end = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60))
        for logical_id in ("LightWorkerFunction", "DeepWorkerFunction"):
            function_name = self._resource(logical_id)["PhysicalResourceId"]
            metric = self._call(
                "cloudwatch",
                "get-metric-statistics",
                "--namespace",
                "AWS/Lambda",
                "--metric-name",
                "Invocations",
                "--dimensions",
                f"Name=FunctionName,Value={function_name}",
                "--start-time",
                start,
                "--end-time",
                end,
                "--period",
                "60",
                "--statistics",
                "Sum",
            )
            if sum(float(point.get("Sum", 0)) for point in metric.get("Datapoints", [])) != 0:
                raise HarnessError("worker invocation was detected")
        query = json.dumps(
            [
                {
                    "Id": "bedrockinvocations",
                    "Expression": "SUM(SEARCH('{AWS/Bedrock} MetricName=\"Invocations\"', 'Sum', 60))",
                    "ReturnData": True,
                }
            ],
            separators=(",", ":"),
        )
        metric = self._call(
            "cloudwatch",
            "get-metric-data",
            "--metric-data-queries",
            query,
            "--start-time",
            start,
            "--end-time",
            end,
            "--scan-by",
            "TimestampAscending",
        )
        results = metric.get("MetricDataResults", [])
        if results and sum(float(value) for value in results[0].get("Values", [])) != 0:
            raise HarnessError("Bedrock invocation was detected")

    def api_base(self) -> str:
        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        if not re.fullmatch(r"[a-z0-9]+", api_id):
            raise HarnessError("staging API identifier is invalid")
        return f"https://{api_id}.execute-api.{REGION}.amazonaws.com/{STAGE_NAME}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise HarnessError("API redirect was refused")


def _request_json(base_url: str, method: str, path: str, token: str, body: dict[str, Any] | None = None, idempotency_key: str | None = None) -> tuple[int, str]:
    url = base_url + path
    parsed = urllib.parse.urlparse(url)
    expected_host = f"{parsed.hostname}"
    if parsed.scheme != "https" or not expected_host.endswith(f".execute-api.{REGION}.amazonaws.com") or "/staging/" not in parsed.path:
        raise HarnessError("API URL is outside the staging boundary")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        response = opener.open(request, timeout=30)
        status = response.status
        raw = response.read(8193)
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read(8193)
    except HarnessError:
        raise
    except Exception as error:
        raise HarnessError("staging API request failed") from error
    if len(raw) > 8192:
        raise HarnessError("staging API response was too large")
    try:
        parsed_body = json.loads(raw.decode("utf-8"))
        code = parsed_body["error"]["code"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise HarnessError("staging API response contract was invalid") from error
    if not isinstance(code, str):
        raise HarnessError("staging API error code was invalid")
    return status, code


def _validate_existing_user(item: dict[str, Any]) -> None:
    if set(item) != {"user_id", "password", "plan", "subscription_status"}:
        raise HarnessError("existing staging test user has unexpected attributes")
    password = item.get("password", {}).get("S", "")
    if item.get("user_id") != {"S": TEST_USER_ID} or item.get("plan") != {"S": "light"} or item.get("subscription_status") != {"S": "active"} or not password.startswith("pbkdf2_sha256$"):
        raise HarnessError("existing staging test user is inconsistent")


def execute_harness(backend: AwsCliBackend) -> dict[str, Any]:
    backend.validate_boundary()
    backend.validate_runtime()
    session_secret = backend.validate_secret_and_get_session_secret()
    token = ""
    try:
        password_hash, create_session_token = _lambda_imports()
        existing = backend.get_item("ReadingUsersTable", {"user_id": {"S": TEST_USER_ID}})
        created = False
        if existing is None:
            password = secrets.token_urlsafe(48)
            item = {
                "user_id": {"S": TEST_USER_ID},
                "password": {"S": password_hash(password)},
                "plan": {"S": "light"},
                "subscription_status": {"S": "active"},
            }
            backend.put_test_user(item)
            created = True
            del password, item
        else:
            _validate_existing_user(existing)
        before = backend.side_effect_state()
        if before["missing_job"] is not None:
            raise HarnessError("fixed missing job reference is already in use")
        token = create_session_token(TEST_USER_ID, secret=session_secret)
        smoke_started = time.time()
        os.environ["SHIRONE_STAGING_SESSION_TOKEN"] = token
        post_status, post_code = _request_json(
            backend.api_base(),
            "POST",
            "/reading",
            token,
            {"name": "架空 テスト", "birth_date": "1984-12-29"},
            str(uuid.uuid4()),
        )
        if (post_status, post_code) != (503, "READING_ASYNC_PAID_DISABLED"):
            raise HarnessError("POST smoke response did not match the contract")
        get_status, get_code = _request_json(
            backend.api_base(),
            "GET",
            f"/reading/status?job_ref={urllib.parse.quote(MISSING_JOB_REF)}",
            token,
        )
        if (get_status, get_code) != (404, "READING_STATUS_NOT_FOUND"):
            raise HarnessError("GET smoke response did not match the contract")
        after = backend.side_effect_state()
        if before != after:
            raise HarnessError("smoke test produced an unexpected side effect")
        backend.validate_no_worker_or_bedrock_invocations(smoke_started)
        return {"created": created, "post": "PASS", "get": "PASS", "side_effects": "ZERO"}
    finally:
        os.environ.pop("SHIRONE_STAGING_SESSION_TOKEN", None)
        token = ""
        session_secret = ""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="staging-only reading API smoke harness")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.execute or args.confirm != CONFIRMATION:
        print("STAGING_CLI_HARNESS_DRY_RUN_ONLY")
        return 0
    try:
        result = execute_harness(AwsCliBackend(load_config(os.environ)))
    except HarnessError as error:
        print(f"STAGING_CLI_HARNESS_FAILED: {error}")
        return 1
    except Exception:
        print("STAGING_CLI_HARNESS_FAILED: unexpected local failure")
        return 1
    print("STAGING_CLI_HARNESS_PASS")
    print(f"test_user_created: {str(result['created']).lower()}")
    print("post_reading: PASS")
    print("get_reading_status: PASS")
    print("unexpected_side_effects: 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
