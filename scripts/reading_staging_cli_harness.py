"""Fail-closed staging test-ID preparation and Phase 1 API smoke harness.

The command is inert unless ``--execute`` and the exact confirmation phrase
are supplied. AWS access uses one boto3 Session. Secret values, fixture
passwords, and bearer tokens remain local variables and are never printed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
STACK_NAME = "nana-reading-staging"
STAGE_NAME = "staging"
TEST_USER_ID = "reading-light-smoke@staging.invalid"
MISSING_JOB_REF = "11111111-1111-4111-8111-111111111111"
CONFIRMATION = "CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE"
METRIC_MAX_WAIT_SECONDS = 300
METRIC_RETRY_SECONDS = 30
EXPECTED_PARAMETERS = {
    "ReadingGenerateApiEnabled": "true",
    "ReadingStatusApiEnabled": "true",
    "ReadingAsyncPaidEnabled": "false",
    "ReadingBedrockEnabled": "false",
    "WorkerEventSourceMappingsEnabled": "false",
}
EXPECTED_RESOURCE_TYPES = {
    "DeepDeadLetterQueue": "AWS::SQS::Queue",
    "DeepEventSourceMapping": "AWS::Lambda::EventSourceMapping",
    "DeepQueue": "AWS::SQS::Queue",
    "DeepWorkerFunction": "AWS::Lambda::Function",
    "DeepWorkerLogGroup": "AWS::Logs::LogGroup",
    "DeepWorkerRole": "AWS::IAM::Role",
    "LightDeadLetterQueue": "AWS::SQS::Queue",
    "LightEventSourceMapping": "AWS::Lambda::EventSourceMapping",
    "LightQueue": "AWS::SQS::Queue",
    "LightWorkerFunction": "AWS::Lambda::Function",
    "LightWorkerLogGroup": "AWS::Logs::LogGroup",
    "LightWorkerRole": "AWS::IAM::Role",
    "ReadingApiStage": "AWS::ApiGatewayV2::Stage",
    "ReadingDeepQuotaTable": "AWS::DynamoDB::Table",
    "ReadingHistoryTable": "AWS::DynamoDB::Table",
    "ReadingHttpApi": "AWS::ApiGatewayV2::Api",
    "ReadingIdempotencyTable": "AWS::DynamoDB::Table",
    "ReadingJobsTable": "AWS::DynamoDB::Table",
    "ReadingRateLimitTable": "AWS::DynamoDB::Table",
    "ReadingRequestFunction": "AWS::Lambda::Function",
    "ReadingRequestIntegration": "AWS::ApiGatewayV2::Integration",
    "ReadingRequestInvokePermission": "AWS::Lambda::Permission",
    "ReadingRequestLogGroup": "AWS::Logs::LogGroup",
    "ReadingRequestRole": "AWS::IAM::Role",
    "ReadingRequestRoute": "AWS::ApiGatewayV2::Route",
    "ReadingStatusFunction": "AWS::Lambda::Function",
    "ReadingStatusIntegration": "AWS::ApiGatewayV2::Integration",
    "ReadingStatusInvokePermission": "AWS::Lambda::Permission",
    "ReadingStatusLogGroup": "AWS::Logs::LogGroup",
    "ReadingStatusRole": "AWS::IAM::Role",
    "ReadingStatusRoute": "AWS::ApiGatewayV2::Route",
    "ReadingUsersTable": "AWS::DynamoDB::Table",
}
TABLE_LOGICAL_IDS = (
    "ReadingUsersTable",
    "ReadingHistoryTable",
    "ReadingIdempotencyTable",
    "ReadingRateLimitTable",
    "ReadingDeepQuotaTable",
    "ReadingJobsTable",
)
QUEUE_LOGICAL_IDS = ("LightQueue", "DeepQueue", "LightDeadLetterQueue", "DeepDeadLetterQueue")
ESM_LOGICAL_IDS = ("LightEventSourceMapping", "DeepEventSourceMapping")
FUNCTION_LOGICAL_IDS = (
    "ReadingRequestFunction",
    "ReadingStatusFunction",
    "LightWorkerFunction",
    "DeepWorkerFunction",
)
CLIENT_SERVICES = (
    "sts",
    "cloudformation",
    "secretsmanager",
    "lambda",
    "apigatewayv2",
    "sqs",
    "dynamodb",
    "cloudwatch",
)


class HarnessError(RuntimeError):
    """A fixed, non-sensitive harness failure."""


@dataclass(frozen=True)
class HarnessConfig:
    expected_account_id: str
    runtime_secret_arn: str


def _lambda_imports() -> tuple[Any, Any, Any]:
    lambda_dir = Path(__file__).resolve().parents[1] / "lambda"
    if str(lambda_dir) not in sys.path:
        sys.path.insert(0, str(lambda_dir))
    from auth_security import password_hash, password_matches  # type: ignore
    from session_token import create_session_token  # type: ignore

    return password_hash, password_matches, create_session_token


def load_config(env: Mapping[str, str]) -> HarnessConfig:
    account = env.get("SHIRONE_STAGING_EXPECTED_ACCOUNT_ID", "")
    secret_arn = env.get("SHIRONE_STAGING_RUNTIME_SECRET_ARN", "")
    if not re.fullmatch(r"[0-9]{12}", account):
        raise HarnessError("expected staging account is not configured")
    pattern = rf"arn:aws:secretsmanager:{re.escape(REGION)}:{account}:secret:[A-Za-z0-9/_+=.@-]+"
    if not re.fullmatch(pattern, secret_arn) or "staging" not in secret_arn.lower() or "prod" in secret_arn.lower():
        raise HarnessError("runtime secret ARN is outside the staging boundary")
    return HarnessConfig(account, secret_arn)


def _load_session_factory() -> Callable[..., Any]:
    try:
        import boto3  # type: ignore
    except ImportError as error:
        raise HarnessError("boto3 is required for approved AWS execution") from error
    return boto3.Session


def _safe_tags(items: Any) -> dict[str, str]:
    if not isinstance(items, list):
        return {}
    return {
        item.get("Key"): item.get("Value")
        for item in items
        if isinstance(item, dict) and isinstance(item.get("Key"), str) and isinstance(item.get("Value"), str)
    }


def _is_production_identifier(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    return re.search(r"(?:^|[-_/:])prod(?:uction)?(?:$|[-_/:])", value.lower()) is not None


class AwsSdkBackend:
    """Staging-only adapter backed by one injected boto3 Session."""

    def __init__(
        self,
        config: HarnessConfig,
        session: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        if getattr(session, "region_name", None) != REGION or getattr(session, "profile_name", None) != PROFILE:
            raise HarnessError("SDK session profile or region is outside the staging boundary")
        self.config = config
        self.session = session
        self.clients = {service: session.client(service, region_name=REGION) for service in CLIENT_SERVICES}
        self.resources: dict[str, dict[str, Any]] = {}
        self.table_arns: dict[str, str] = {}
        self.stack_id = ""
        self._put_attempted = False
        self._clock = clock
        self._sleep = sleeper

    @classmethod
    def create(cls, config: HarnessConfig) -> "AwsSdkBackend":
        factory = _load_session_factory()
        return cls(config, factory(profile_name=PROFILE, region_name=REGION))

    def _call(self, service: str, operation: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = getattr(self.clients[service], operation)(**kwargs)
        except Exception as error:
            raise HarnessError(f"AWS operation failed: {service}/{operation}") from error
        if not isinstance(response, dict):
            raise HarnessError(f"AWS response shape was invalid: {service}/{operation}")
        return response

    def _resource(self, logical_id: str) -> dict[str, Any]:
        value = self.resources.get(logical_id)
        if not value or not isinstance(value.get("PhysicalResourceId"), str):
            raise HarnessError("required staging resource is missing")
        return value

    def _validate_identity(self) -> None:
        identity = self._call("sts", "get_caller_identity")
        arn = identity.get("Arn", "")
        if (
            identity.get("Account") != self.config.expected_account_id
            or not isinstance(arn, str)
            or ":assumed-role/" not in arn
            or arn.endswith(":root")
            or _is_production_identifier(arn)
        ):
            raise HarnessError("AWS identity is outside the staging boundary")

    def _validate_stack(self, *, refresh_resources: bool) -> dict[str, str]:
        stacks = self._call("cloudformation", "describe_stacks", StackName=STACK_NAME).get("Stacks", [])
        if len(stacks) != 1 or not isinstance(stacks[0], dict) or stacks[0].get("StackStatus") != "UPDATE_COMPLETE":
            raise HarnessError("staging stack is not ready")
        stack = stacks[0]
        stack_id = stack.get("StackId", "")
        expected_stack_prefix = f"arn:aws:cloudformation:{REGION}:{self.config.expected_account_id}:stack/{STACK_NAME}/"
        if (
            stack.get("StackName") != STACK_NAME
            or not isinstance(stack_id, str)
            or not stack_id.startswith(expected_stack_prefix)
            or _is_production_identifier(stack_id)
        ):
            raise HarnessError("stack identity is outside the staging boundary")
        self.stack_id = stack_id
        parameters = {
            item.get("ParameterKey"): item.get("ParameterValue")
            for item in stack.get("Parameters", [])
            if isinstance(item, dict)
        }
        if any(parameters.get(key) != value for key, value in EXPECTED_PARAMETERS.items()):
            raise HarnessError("staging safety switches are invalid")
        if refresh_resources:
            summaries = self._call("cloudformation", "list_stack_resources", StackName=STACK_NAME).get(
                "StackResourceSummaries", []
            )
            current = {
                item.get("LogicalResourceId"): item
                for item in summaries
                if isinstance(item, dict) and isinstance(item.get("LogicalResourceId"), str)
            }
            if set(current) != set(EXPECTED_RESOURCE_TYPES):
                raise HarnessError("staging resource inventory is incomplete")
            for logical_id, expected_type in EXPECTED_RESOURCE_TYPES.items():
                resource = current[logical_id]
                status = resource.get("ResourceStatus")
                physical_id = resource.get("PhysicalResourceId")
                if (
                    resource.get("ResourceType") != expected_type
                    or not isinstance(status, str)
                    or not status.endswith("_COMPLETE")
                    or status.startswith(("DELETE_", "ROLLBACK_"))
                    or not isinstance(physical_id, str)
                    or not physical_id
                    or _is_production_identifier(physical_id)
                ):
                    raise HarnessError("staging resource inventory is invalid")
            if self.resources and any(
                current[key].get("PhysicalResourceId") != self.resources[key].get("PhysicalResourceId")
                for key in EXPECTED_RESOURCE_TYPES
            ):
                raise HarnessError("staging resource inventory changed during execution")
            self.resources = current
        return parameters

    def validate_boundary(self) -> dict[str, str]:
        self._validate_identity()
        return self._validate_stack(refresh_resources=True)

    def _validate_resource_tags(
        self,
        logical_id: str,
        value: Any,
        *,
        require_cloudformation_ownership: bool = True,
    ) -> None:
        resource_tags = value if isinstance(value, dict) else {}
        expected = {
            "Project": "nana-fortune",
            "Environment": STAGE_NAME,
        }
        if require_cloudformation_ownership:
            expected.update(
                {
                    "aws:cloudformation:stack-id": self.stack_id,
                    "aws:cloudformation:stack-name": STACK_NAME,
                    "aws:cloudformation:logical-id": logical_id,
                }
            )
        if any(resource_tags.get(key) != expected_value for key, expected_value in expected.items()):
            raise HarnessError("staging resource tags are invalid")

    def _validate_secret_metadata(self) -> None:
        description = self._call(
            "secretsmanager", "describe_secret", SecretId=self.config.runtime_secret_arn
        )
        if description.get("ARN") != self.config.runtime_secret_arn:
            raise HarnessError("runtime secret identity is outside the staging boundary")
        tags = _safe_tags(description.get("Tags"))
        if tags.get("Environment") != STAGE_NAME or tags.get("Project") != "nana-fortune":
            raise HarnessError("runtime secret tags are outside the staging boundary")

    def validate_secret_and_get_session_secret(self) -> str:
        self._validate_secret_metadata()
        secret_response = self._call(
            "secretsmanager", "get_secret_value", SecretId=self.config.runtime_secret_arn
        )
        secret_string = secret_response.get("SecretString")
        if not isinstance(secret_string, str):
            raise HarnessError("runtime secret document is invalid")
        try:
            secret_document = json.loads(secret_string)
        except json.JSONDecodeError as error:
            raise HarnessError("runtime secret document is invalid") from error
        session_secret = secret_document.get("session_token_secret") if isinstance(secret_document, dict) else None
        if not isinstance(session_secret, str) or len(session_secret) < 32:
            raise HarnessError("runtime session secret is invalid")
        for logical_id in ("ReadingRequestFunction", "ReadingStatusFunction"):
            function_name = self._resource(logical_id)["PhysicalResourceId"]
            configuration = self._call("lambda", "get_function_configuration", FunctionName=function_name)
            deployed_secret = configuration.get("Environment", {}).get("Variables", {}).get("SESSION_TOKEN_SECRET")
            if not isinstance(deployed_secret, str) or not hmac.compare_digest(session_secret, deployed_secret):
                raise HarnessError("runtime secret does not match the staging API Lambda")
        return session_secret

    def _validate_table(self, logical_id: str, *, expected_arn: str | None = None) -> str:
        table_name = self._resource(logical_id)["PhysicalResourceId"]
        if _is_production_identifier(table_name):
            raise HarnessError("DynamoDB table is outside the staging boundary")
        table = self._call("dynamodb", "describe_table", TableName=table_name).get("Table", {})
        arn = table.get("TableArn", "") if isinstance(table, dict) else ""
        expected_prefix = f"arn:aws:dynamodb:{REGION}:{self.config.expected_account_id}:table/"
        if (
            not isinstance(table, dict)
            or table.get("TableStatus") != "ACTIVE"
            or not isinstance(arn, str)
            or not arn.startswith(expected_prefix)
            or _is_production_identifier(arn)
            or (expected_arn is not None and arn != expected_arn)
        ):
            raise HarnessError("DynamoDB table is outside the staging boundary")
        return arn

    def _queue_attributes(self, logical_id: str) -> dict[str, str]:
        queue_url = self._resource(logical_id)["PhysicalResourceId"]
        if _is_production_identifier(queue_url):
            raise HarnessError("staging queue is outside the staging boundary")
        value = self._call(
            "sqs",
            "get_queue_attributes",
            QueueUrl=queue_url,
            AttributeNames=[
                "QueueArn",
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ],
        ).get("Attributes", {})
        expected_prefix = f"arn:aws:sqs:{REGION}:{self.config.expected_account_id}:"
        if not isinstance(value, dict) or not str(value.get("QueueArn", "")).startswith(expected_prefix):
            raise HarnessError("staging queue is outside the staging boundary")
        queue_name = queue_url.rsplit("/", 1)[-1]
        if value.get("QueueArn") != f"{expected_prefix}{queue_name}":
            raise HarnessError("staging queue physical identity is invalid")
        queue_tags = self._call("sqs", "list_queue_tags", QueueUrl=queue_url).get("Tags", {})
        # CloudFormation does not expose its three generated ownership tags on
        # these deployed SQS resources. The explicit template tags and the
        # CloudFormation logical/physical inventory remain mandatory.
        self._validate_resource_tags(logical_id, queue_tags, require_cloudformation_ownership=False)
        for key in (
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed",
        ):
            try:
                count = int(value.get(key, ""))
            except (TypeError, ValueError) as error:
                raise HarnessError("staging queue attributes are invalid") from error
            if count != 0:
                raise HarnessError("staging queue is not empty")
        return {str(key): str(item) for key, item in value.items()}

    def _event_source_mapping_state(self, logical_id: str) -> dict[str, str]:
        expected_uuid = self._resource(logical_id)["PhysicalResourceId"]
        value = self._call("lambda", "get_event_source_mapping", UUID=expected_uuid)
        if value.get("State") != "Disabled" or value.get("UUID") not in (None, expected_uuid):
            raise HarnessError("worker event source mapping is enabled or mismatched")
        return {"State": "Disabled", "UUID": expected_uuid}

    def validate_runtime(self) -> dict[str, Any]:
        function_configurations: dict[str, dict[str, Any]] = {}
        expected_lambda_prefix = f"arn:aws:lambda:{REGION}:{self.config.expected_account_id}:function:"
        for logical_id in FUNCTION_LOGICAL_IDS:
            physical_id = self._resource(logical_id)["PhysicalResourceId"]
            configuration = self._call("lambda", "get_function_configuration", FunctionName=physical_id)
            function_arn = configuration.get("FunctionArn", "")
            if (
                configuration.get("State") != "Active"
                or configuration.get("LastUpdateStatus") != "Successful"
                or configuration.get("FunctionName") not in (None, physical_id)
                or not isinstance(function_arn, str)
                or not function_arn.startswith(expected_lambda_prefix)
                or _is_production_identifier(function_arn)
            ):
                raise HarnessError("staging Lambda is not ready")
            function_tags = self._call("lambda", "list_tags", Resource=function_arn).get("Tags", {})
            self._validate_resource_tags(logical_id, function_tags)
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
        for logical_id in ESM_LOGICAL_IDS:
            self._event_source_mapping_state(logical_id)
        for logical_id in QUEUE_LOGICAL_IDS:
            self._queue_attributes(logical_id)
        self.table_arns = {logical_id: self._validate_table(logical_id) for logical_id in TABLE_LOGICAL_IDS}
        users_tags = self._call(
            "dynamodb", "list_tags_of_resource", ResourceArn=self.table_arns["ReadingUsersTable"]
        ).get("Tags", [])
        self._validate_resource_tags("ReadingUsersTable", _safe_tags(users_tags))

        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        if not re.fullmatch(r"[a-z0-9]+", api_id) or _is_production_identifier(api_id):
            raise HarnessError("staging API identifier is invalid")
        api_arn = f"arn:aws:apigateway:{REGION}::/apis/{api_id}"
        api_tags = self._call("apigatewayv2", "get_tags", ResourceArn=api_arn).get("Tags", {})
        self._validate_resource_tags("ReadingHttpApi", api_tags)
        routes = self._call("apigatewayv2", "get_routes", ApiId=api_id).get("Items", [])
        route_map = {
            item.get("RouteKey"): (item.get("RouteId"), item.get("Target"))
            for item in routes
            if isinstance(item, dict) and isinstance(item.get("RouteKey"), str)
        }
        expected_routes = {
            "POST /reading": (
                self._resource("ReadingRequestRoute")["PhysicalResourceId"],
                f"integrations/{self._resource('ReadingRequestIntegration')['PhysicalResourceId']}",
            ),
            "GET /reading/status": (
                self._resource("ReadingStatusRoute")["PhysicalResourceId"],
                f"integrations/{self._resource('ReadingStatusIntegration')['PhysicalResourceId']}",
            ),
        }
        if route_map != expected_routes:
            raise HarnessError("staging API route targets are invalid")

        integrations: dict[str, Any] = {}
        for logical_id, function_logical_id, expected_timeout in (
            ("ReadingRequestIntegration", "ReadingRequestFunction", 29000),
            ("ReadingStatusIntegration", "ReadingStatusFunction", 10000),
        ):
            integration_id = self._resource(logical_id)["PhysicalResourceId"]
            value = self._call(
                "apigatewayv2", "get_integration", ApiId=api_id, IntegrationId=integration_id
            )
            if (
                value.get("IntegrationId") not in (None, integration_id)
                or value.get("IntegrationType") not in (None, "AWS_PROXY")
                or value.get("IntegrationMethod") not in (None, "POST")
                or value.get("PayloadFormatVersion") != "2.0"
                or value.get("TimeoutInMillis") != expected_timeout
                or value.get("RequestParameters") not in (None, {})
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
            "get_item",
            TableName=self._table_name(logical_id),
            Key=key,
            ConsistentRead=True,
        )
        item = value.get("Item")
        return item if isinstance(item, dict) else None

    def _pre_write_revalidate(self) -> None:
        self._validate_identity()
        self._validate_stack(refresh_resources=True)
        users_arn = self.table_arns.get("ReadingUsersTable")
        if not users_arn:
            raise HarnessError("users table was not validated")
        self._validate_table("ReadingUsersTable", expected_arn=users_arn)
        users_tags = self._call("dynamodb", "list_tags_of_resource", ResourceArn=users_arn).get("Tags", [])
        self._validate_resource_tags("ReadingUsersTable", _safe_tags(users_tags))
        self._validate_secret_metadata()

    @staticmethod
    def _error_code(error: Exception) -> str | None:
        response = getattr(error, "response", None)
        if not isinstance(response, dict):
            return None
        error_value = response.get("Error")
        return error_value.get("Code") if isinstance(error_value, dict) else None

    def put_test_user(self, item: dict[str, Any], fixture_password: str, password_matches: Any) -> bool:
        if self._put_attempted or item.get("user_id") != {"S": TEST_USER_ID}:
            raise HarnessError("test user write scope was exceeded")
        self._put_attempted = True
        self._pre_write_revalidate()
        try:
            self.clients["dynamodb"].put_item(
                TableName=self._table_name("ReadingUsersTable"),
                Item=item,
                ConditionExpression="attribute_not_exists(user_id)",
            )
            return True
        except Exception as error:
            if self._error_code(error) != "ConditionalCheckFailedException":
                raise HarnessError("staging test user conditional write failed") from error
        existing = self.get_item("ReadingUsersTable", {"user_id": {"S": TEST_USER_ID}})
        if existing is None:
            raise HarnessError("conditional write raced without an existing fixture")
        _validate_existing_user(existing, fixture_password, password_matches)
        return False

    def side_effect_state(self) -> dict[str, Any]:
        return {
            "queues": {logical_id: self._queue_attributes(logical_id) for logical_id in QUEUE_LOGICAL_IDS},
            "esm": {
                logical_id: self._event_source_mapping_state(logical_id)
                for logical_id in ESM_LOGICAL_IDS
            },
            "test_user": self.get_item("ReadingUsersTable", {"user_id": {"S": TEST_USER_ID}}),
            "missing_job": self.get_item("ReadingJobsTable", {"job_ref": {"S": MISSING_JOB_REF}}),
        }

    def _metric_snapshot(self, started_at: float, finished_at: float) -> dict[str, str]:
        start = datetime.fromtimestamp(started_at, timezone.utc)
        end = datetime.fromtimestamp(max(finished_at, started_at + 1), timezone.utc)
        evidence: dict[str, str] = {}
        for logical_id in ("LightWorkerFunction", "DeepWorkerFunction"):
            function_name = self._resource(logical_id)["PhysicalResourceId"]
            metric = self._call(
                "cloudwatch",
                "get_metric_statistics",
                Namespace="AWS/Lambda",
                MetricName="Invocations",
                Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                StartTime=start,
                EndTime=end,
                Period=60,
                Statistics=["Sum"],
            )
            datapoints = metric.get("Datapoints")
            if not isinstance(datapoints, list) or not datapoints:
                evidence[logical_id] = "NO_DATA"
                continue
            try:
                total = sum(float(point["Sum"]) for point in datapoints if isinstance(point, dict))
            except (KeyError, TypeError, ValueError) as error:
                raise HarnessError("worker invocation metric shape was invalid") from error
            if total != 0:
                raise HarnessError("worker invocation was detected")
            evidence[logical_id] = "ZERO_CONFIRMED"
        metric = self._call(
            "cloudwatch",
            "get_metric_data",
            MetricDataQueries=[
                {
                    "Id": "bedrockinvocations",
                    "Expression": "SUM(SEARCH('{AWS/Bedrock} MetricName=\"Invocations\"', 'Sum', 60))",
                    "ReturnData": True,
                }
            ],
            StartTime=start,
            EndTime=end,
            ScanBy="TimestampAscending",
        )
        results = metric.get("MetricDataResults")
        if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
            evidence["Bedrock"] = "NO_DATA"
        else:
            result = results[0]
            values = result.get("Values")
            if result.get("StatusCode") != "Complete" or not isinstance(values, list) or not values:
                evidence["Bedrock"] = "NO_DATA"
            else:
                try:
                    total = sum(float(value) for value in values)
                except (TypeError, ValueError) as error:
                    raise HarnessError("Bedrock invocation metric shape was invalid") from error
                if total != 0:
                    raise HarnessError("Bedrock invocation was detected")
                evidence["Bedrock"] = "ZERO_CONFIRMED"
        return evidence

    def validate_no_worker_or_bedrock_invocations(self, started_at: float, finished_at: float) -> dict[str, str]:
        deadline = self._clock() + METRIC_MAX_WAIT_SECONDS
        while True:
            evidence = self._metric_snapshot(started_at, finished_at)
            if evidence and all(value == "ZERO_CONFIRMED" for value in evidence.values()):
                return evidence
            if self._clock() >= deadline:
                raise HarnessError("invocation metrics remained NO_DATA")
            self._sleep(METRIC_RETRY_SECONDS)

    def api_base(self) -> str:
        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        if not re.fullmatch(r"[a-z0-9]+", api_id) or _is_production_identifier(api_id):
            raise HarnessError("staging API identifier is invalid")
        return f"https://{api_id}.execute-api.{REGION}.amazonaws.com/{STAGE_NAME}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        # Returning no request ensures Authorization is never forwarded.
        raise HarnessError("API redirect was refused")


def _request_json(
    base_url: str,
    method: str,
    path: str,
    token: str,
    body: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> tuple[int, str]:
    url = base_url + path
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or not parsed.hostname.endswith(f".execute-api.{REGION}.amazonaws.com")
        or not parsed.path.startswith(f"/{STAGE_NAME}/")
    ):
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


def _fixture_password(session_secret: str) -> str:
    digest = hmac.new(
        session_secret.encode("utf-8"), b"shirone-staging-cli-fixture-password-v1", hashlib.sha256
    ).digest()
    return "StagingFixture-" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _validate_existing_user(item: dict[str, Any], fixture_password: str, password_matches: Any) -> None:
    if set(item) != {"user_id", "password", "plan", "subscription_status"}:
        raise HarnessError("existing staging test user has unexpected attributes")
    password_value = item.get("password")
    stored_hash = password_value.get("S") if isinstance(password_value, dict) else None
    if (
        item.get("user_id") != {"S": TEST_USER_ID}
        or item.get("plan") != {"S": "light"}
        or item.get("subscription_status") != {"S": "active"}
        or not isinstance(stored_hash, str)
    ):
        raise HarnessError("existing staging test user is inconsistent")
    verification = password_matches(fixture_password, stored_hash)
    if not getattr(verification, "accepted", False) or getattr(verification, "legacy", True):
        raise HarnessError("existing staging test user password hash is invalid")


def execute_harness(backend: AwsSdkBackend) -> dict[str, Any]:
    backend.validate_boundary()
    backend.validate_runtime()
    session_secret = backend.validate_secret_and_get_session_secret()
    token = ""
    fixture_password = ""
    try:
        password_hash, password_matches, create_session_token = _lambda_imports()
        fixture_password = _fixture_password(session_secret)
        existing = backend.get_item("ReadingUsersTable", {"user_id": {"S": TEST_USER_ID}})
        created = False
        if existing is None:
            item = {
                "user_id": {"S": TEST_USER_ID},
                "password": {"S": password_hash(fixture_password)},
                "plan": {"S": "light"},
                "subscription_status": {"S": "active"},
            }
            created = backend.put_test_user(item, fixture_password, password_matches)
            del item
        else:
            _validate_existing_user(existing, fixture_password, password_matches)
        before = backend.side_effect_state()
        if before["missing_job"] is not None:
            raise HarnessError("fixed missing job reference is already in use")
        token = create_session_token(TEST_USER_ID, secret=session_secret)
        smoke_started = time.time()
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
        smoke_finished = time.time()
        if (get_status, get_code) != (404, "READING_STATUS_NOT_FOUND"):
            raise HarnessError("GET smoke response did not match the contract")
        after = backend.side_effect_state()
        if before != after:
            raise HarnessError("smoke test produced an unexpected side effect")
        backend.validate_no_worker_or_bedrock_invocations(smoke_started, smoke_finished)
        return {"created": created, "post": "PASS", "get": "PASS", "side_effects": "ZERO"}
    finally:
        # Reference clearing reduces lifetime; Python does not guarantee secure
        # erasure of immutable strings from process memory.
        token = ""
        fixture_password = ""
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
        config = load_config(os.environ)
        result = execute_harness(AwsSdkBackend.create(config))
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
