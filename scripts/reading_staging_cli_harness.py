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
import math
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


PROFILE = "shirone-staging-graduation"
REGION = "ap-northeast-1"
PARTITION = "aws"
STACK_NAME = "nana-reading-staging"
STAGE_NAME = "staging"
TEST_USER_ID = "reading-light-smoke@staging.invalid"
MISSING_JOB_REF = "11111111-1111-4111-8111-111111111111"
CONFIRMATION = "CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE"
METRIC_MAX_WAIT_SECONDS = 300
METRIC_RETRY_SECONDS = 30
METRIC_MEASURED_ZERO = "MEASURED_ZERO"
METRIC_MEASURED_NONZERO = "MEASURED_NONZERO"
METRIC_NO_DATA = "NO_DATA"
METRIC_QUERY_FAILURE = "QUERY_FAILURE"
EVIDENCE_ZERO_MEASURED = "ZERO_INVOCATIONS_MEASURED"
EVIDENCE_NO_INVOCATION_WITH_CONTROLS = "NO_INVOCATION_OBSERVED_WITH_DETERMINISTIC_CONTROLS"
EXPECTED_PARAMETERS = {
    "ReadingGenerateApiEnabled": "true",
    "ReadingStatusApiEnabled": "true",
    "ReadingAsyncPaidEnabled": "false",
    "ReadingBedrockEnabled": "false",
    "WorkerEventSourceMappingsEnabled": "false",
    "FincodeWebhookEnabled": "false",
    "FincodePeriodSourceEnabled": "false",
    "FincodeProvisionalTestPeriodSourceEnabled": "false",
    "FincodeOneTimeVoiceWebhookEnabled": "false",
    "ReadingLightQuotaEnabled": "false",
}
EXPECTED_RESOURCE_TYPES = {
    "FincodeCustomerMappingTable": "AWS::DynamoDB::Table",
    "FincodeLightQuotaTable": "AWS::DynamoDB::Table",
    "FincodeOneTimeVoicePurchaseTable": "AWS::DynamoDB::Table",
    "FincodeWebhookFunction": "AWS::Lambda::Function",
    "FincodeWebhookHttpApi": "AWS::ApiGatewayV2::Api",
    "FincodeWebhookApiStage": "AWS::ApiGatewayV2::Stage",
    "FincodeWebhookIntegration": "AWS::ApiGatewayV2::Integration",
    "FincodeWebhookInvokePermission": "AWS::Lambda::Permission",
    "FincodeWebhookLedgerTable": "AWS::DynamoDB::Table",
    "FincodeWebhookLogGroup": "AWS::Logs::LogGroup",
    "FincodeWebhookRole": "AWS::IAM::Role",
    "FincodeWebhookRoute": "AWS::ApiGatewayV2::Route",
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
    "FincodeWebhookLedgerTable",
    "FincodeCustomerMappingTable",
    "FincodeLightQuotaTable",
    "FincodeOneTimeVoicePurchaseTable",
)
QUEUE_LOGICAL_IDS = ("LightQueue", "DeepQueue", "LightDeadLetterQueue", "DeepDeadLetterQueue")
ESM_LOGICAL_IDS = ("LightEventSourceMapping", "DeepEventSourceMapping")
ROUTE_LOGICAL_IDS = ("ReadingRequestRoute", "ReadingStatusRoute")
INTEGRATION_LOGICAL_IDS = ("ReadingRequestIntegration", "ReadingStatusIntegration")
FUNCTION_LOGICAL_IDS = (
    "ReadingRequestFunction",
    "ReadingStatusFunction",
    "LightWorkerFunction",
    "DeepWorkerFunction",
)
CLIENT_SERVICES = (
    "sts",
    "cloudformation",
    "lambda",
    "apigatewayv2",
    "sqs",
    "dynamodb",
    "cloudwatch",
)
SESSION_SECRET_ENV_KEY = "SESSION_TOKEN_SECRET"


class HarnessError(RuntimeError):
    """A fixed, non-sensitive harness failure."""


@dataclass(frozen=True)
class HarnessConfig:
    expected_account_id: str


def _lambda_imports() -> tuple[Any, Any, Any]:
    lambda_dir = Path(__file__).resolve().parents[1] / "lambda"
    if str(lambda_dir) not in sys.path:
        sys.path.insert(0, str(lambda_dir))
    from auth_security import password_hash, password_matches  # type: ignore
    from session_token import create_session_token  # type: ignore

    return password_hash, password_matches, create_session_token


def load_config(env: Mapping[str, str]) -> HarnessConfig:
    account = env.get("SHIRONE_STAGING_EXPECTED_ACCOUNT_ID", "")
    if not re.fullmatch(r"[0-9]{12}", account):
        raise HarnessError("expected staging account is not configured")
    return HarnessConfig(account)


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


def _api_gateway_resource_arn(api_id: str, *, expected_api_id: str) -> str:
    if (
        not isinstance(api_id, str)
        or api_id != expected_api_id
        or re.fullmatch(r"[a-z0-9]+", api_id) is None
        or _is_production_identifier(api_id)
    ):
        raise HarnessError("staging API identifier is invalid")
    return f"arn:{PARTITION}:apigateway:{REGION}::/apis/{api_id}"


def _validate_api_gateway_resource_arn(value: str, *, expected_api_id: str) -> None:
    expected = _api_gateway_resource_arn(expected_api_id, expected_api_id=expected_api_id)
    if value != expected or _is_production_identifier(value):
        raise HarnessError("staging API resource ARN is invalid")


def _safe_error_token(value: Any) -> str:
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value) else "UNKNOWN"


def _safe_aws_failure(service: str, operation: str, error: Exception) -> HarnessError:
    exception_class = _safe_error_token(type(error).__name__)
    response = getattr(error, "response", None)
    response = response if isinstance(response, dict) else {}
    metadata = response.get("ResponseMetadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    status = metadata.get("HTTPStatusCode")
    safe_status = str(status) if isinstance(status, int) and 100 <= status <= 599 else "UNKNOWN"
    error_value = response.get("Error")
    error_value = error_value if isinstance(error_value, dict) else {}
    code = _safe_error_token(error_value.get("Code"))
    return HarnessError(
        "AWS_OPERATION_FAILED "
        f"phase={service}/{operation} exception_class={exception_class} "
        f"http_status={safe_status} aws_error_code={code} classification=AWS_SDK_CALL_FAILED"
    )


def _validate_unmanaged_api_gateway_resource(value: Mapping[str, Any]) -> None:
    if "ApiGatewayManaged" not in value:
        return
    if value["ApiGatewayManaged"] is not False:
        raise HarnessError("API Gateway resource is managed or has an invalid managed flag")


def _classify_invocation_values(
    values: Any,
    *,
    query_status: str = "Complete",
    uses_fill: bool = False,
) -> dict[str, Any]:
    if uses_fill or query_status != "Complete" or not isinstance(values, list):
        return {"classification": METRIC_QUERY_FAILURE, "measured_sum": None}
    if not values:
        return {"classification": METRIC_NO_DATA, "measured_sum": None}
    try:
        measured_sum = sum(float(value) for value in values)
    except (TypeError, ValueError):
        return {"classification": METRIC_QUERY_FAILURE, "measured_sum": None}
    if not math.isfinite(measured_sum) or measured_sum < 0:
        return {"classification": METRIC_QUERY_FAILURE, "measured_sum": None}
    return {
        "classification": METRIC_MEASURED_ZERO if measured_sum == 0 else METRIC_MEASURED_NONZERO,
        "measured_sum": measured_sum,
    }


class AwsSdkBackend:
    """Staging-only adapter backed by one injected boto3 Session."""

    def __init__(
        self,
        config: HarnessConfig,
        session: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
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
        self.stack_parameters: dict[str, str] = {}
        self._put_attempted = False
        self._clock = clock
        self._wall_clock = wall_clock
        self._sleep = sleeper

    @classmethod
    def create(cls, config: HarnessConfig) -> "AwsSdkBackend":
        factory = _load_session_factory()
        return cls(config, factory(profile_name=PROFILE, region_name=REGION))

    def _call(self, service: str, operation: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = getattr(self.clients[service], operation)(**kwargs)
        except Exception as error:
            raise _safe_aws_failure(service, operation, error) from None
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
        self.stack_parameters = {
            str(key): str(value)
            for key, value in parameters.items()
            if isinstance(key, str) and isinstance(value, str)
        }
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

    def _explicit_template_tags(self, logical_id: str) -> dict[str, str]:
        template_path = Path(__file__).resolve().parents[1] / "infrastructure" / "reading-staging" / "template.json"
        try:
            template = json.loads(template_path.read_text(encoding="utf-8"))
            properties = template["Resources"][logical_id].get("Properties", {})
            raw_tags = properties.get("Tags", {})
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise HarnessError("tracked staging template tags are unavailable") from error

        if isinstance(raw_tags, list):
            entries = ((item.get("Key"), item.get("Value")) for item in raw_tags if isinstance(item, dict))
        elif isinstance(raw_tags, dict):
            entries = raw_tags.items()
        else:
            raise HarnessError("tracked staging template tags are invalid")

        expected: dict[str, str] = {}
        for key, raw_value in entries:
            if not isinstance(key, str):
                raise HarnessError("tracked staging template tags are invalid")
            if isinstance(raw_value, str):
                value = raw_value
            elif isinstance(raw_value, dict) and set(raw_value) == {"Ref"}:
                value = self.stack_parameters.get(raw_value["Ref"], "")
            else:
                raise HarnessError("tracked staging template tags are invalid")
            if not value:
                raise HarnessError("tracked staging template tags are unresolved")
            expected[key] = value
        if not expected:
            raise HarnessError("tracked staging template has no explicit tags")
        return expected

    def _validate_resource_tags(self, logical_id: str, value: Any) -> None:
        resource_tags = value if isinstance(value, dict) else {}
        expected = self._explicit_template_tags(logical_id)
        if any(resource_tags.get(key) != expected_value for key, expected_value in expected.items()):
            raise HarnessError("staging resource tags are invalid")
        cloudformation_tags = {
            "aws:cloudformation:stack-id": self.stack_id,
            "aws:cloudformation:stack-name": STACK_NAME,
            "aws:cloudformation:logical-id": logical_id,
        }
        if any(
            key in resource_tags and resource_tags[key] != expected_value
            for key, expected_value in cloudformation_tags.items()
        ):
            raise HarnessError("staging CloudFormation resource tags are invalid")
        if any(_is_production_identifier(key) or _is_production_identifier(item) for key, item in resource_tags.items()):
            raise HarnessError("staging resource tags contain a production identifier")

    def _validate_api_secret_and_kms(
        self, function_configurations: Mapping[str, Mapping[str, Any]]
    ) -> tuple[str, str | None]:
        request_configuration = function_configurations.get("ReadingRequestFunction", {})
        status_configuration = function_configurations.get("ReadingStatusFunction", {})
        request_variables = request_configuration.get("Environment", {}).get("Variables", {})
        status_variables = status_configuration.get("Environment", {}).get("Variables", {})
        request_secret = request_variables.get(SESSION_SECRET_ENV_KEY) if isinstance(request_variables, dict) else None
        status_secret = status_variables.get(SESSION_SECRET_ENV_KEY) if isinstance(status_variables, dict) else None
        if not isinstance(request_secret, str) or not request_secret:
            raise HarnessError("request Lambda session secret is missing")
        if not isinstance(status_secret, str) or not status_secret:
            raise HarnessError("status Lambda session secret is missing")
        if not hmac.compare_digest(request_secret, status_secret):
            raise HarnessError("request and status Lambda session secrets differ")

        request_kms = request_configuration.get("KMSKeyArn") or None
        status_kms = status_configuration.get("KMSKeyArn") or None
        if request_kms != status_kms:
            raise HarnessError("request and status Lambda KMS keys differ")
        if request_kms is not None:
            expected_prefix = f"arn:aws:kms:{REGION}:{self.config.expected_account_id}:key/"
            if (
                not isinstance(request_kms, str)
                or not request_kms.startswith(expected_prefix)
                or _is_production_identifier(request_kms)
            ):
                raise HarnessError("Lambda KMS key is outside the staging boundary")
        return request_secret, request_kms

    def _load_function_configurations(self, logical_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
        function_configurations: dict[str, dict[str, Any]] = {}
        expected_lambda_prefix = f"arn:aws:lambda:{REGION}:{self.config.expected_account_id}:function:"
        for logical_id in logical_ids:
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
        return function_configurations

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
        self._validate_resource_tags(logical_id, queue_tags)
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

    def validate_runtime(self) -> str:
        function_configurations = self._load_function_configurations(FUNCTION_LOGICAL_IDS)
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
        session_secret, _kms_key_arn = self._validate_api_secret_and_kms(function_configurations)
        for logical_id in ESM_LOGICAL_IDS:
            self._event_source_mapping_state(logical_id)
        for logical_id in QUEUE_LOGICAL_IDS:
            self._queue_attributes(logical_id)
        self.table_arns = {logical_id: self._validate_table(logical_id) for logical_id in TABLE_LOGICAL_IDS}
        for logical_id, table_arn in self.table_arns.items():
            tags = self._call("dynamodb", "list_tags_of_resource", ResourceArn=table_arn).get("Tags", [])
            self._validate_resource_tags(logical_id, _safe_tags(tags))

        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        _api_gateway_resource_arn(api_id, expected_api_id=api_id)
        api = self._call("apigatewayv2", "get_api", ApiId=api_id)
        api_endpoint = api.get("ApiEndpoint")
        api_name = api.get("Name")
        if (
            api.get("ApiId") != api_id
            or api.get("ProtocolType") != "HTTP"
            or api_name != f"{STACK_NAME}-reading-http-api"
            or api_endpoint != f"https://{api_id}.execute-api.{REGION}.amazonaws.com"
            or _is_production_identifier(api_name)
            or _is_production_identifier(api_endpoint)
        ):
            raise HarnessError("staging HTTP API identity is invalid")
        self._validate_resource_tags("ReadingHttpApi", api.get("Tags"))
        for route_logical_id, route_key, integration_logical_id in (
            ("ReadingRequestRoute", "POST /reading", "ReadingRequestIntegration"),
            ("ReadingStatusRoute", "GET /reading/status", "ReadingStatusIntegration"),
        ):
            route_id = self._resource(route_logical_id)["PhysicalResourceId"]
            integration_id = self._resource(integration_logical_id)["PhysicalResourceId"]
            route = self._call("apigatewayv2", "get_route", ApiId=api_id, RouteId=route_id)
            _validate_unmanaged_api_gateway_resource(route)
            if (
                route.get("RouteId") != route_id
                or route.get("RouteKey") != route_key
                or route.get("Target") != f"integrations/{integration_id}"
                or route.get("AuthorizationType") != "NONE"
                or any(
                    _is_production_identifier(value)
                    for value in (route.get("RouteId"), route.get("RouteKey"), route.get("Target"))
                )
            ):
                raise HarnessError("staging API route target is invalid")

        integrations: dict[str, Any] = {}
        for logical_id, function_logical_id, expected_timeout in (
            ("ReadingRequestIntegration", "ReadingRequestFunction", 29000),
            ("ReadingStatusIntegration", "ReadingStatusFunction", 10000),
        ):
            integration_id = self._resource(logical_id)["PhysicalResourceId"]
            value = self._call(
                "apigatewayv2", "get_integration", ApiId=api_id, IntegrationId=integration_id
            )
            _validate_unmanaged_api_gateway_resource(value)
            if (
                value.get("IntegrationId") != integration_id
                or value.get("IntegrationType") != "AWS_PROXY"
                or value.get("IntegrationMethod") != "POST"
                or value.get("PayloadFormatVersion") != "2.0"
                or value.get("TimeoutInMillis") != expected_timeout
                or value.get("RequestParameters") not in (None, {})
                or value.get("IntegrationUri") != function_configurations[function_logical_id].get("FunctionArn")
                or any(
                    _is_production_identifier(item)
                    for item in (value.get("IntegrationId"), value.get("IntegrationUri"))
                )
            ):
                raise HarnessError("staging API integration is invalid")
            integrations[logical_id] = value
        return session_secret

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

    def _pre_write_revalidate(self, expected_session_secret: str) -> None:
        self._validate_identity()
        self._validate_stack(refresh_resources=True)
        users_arn = self.table_arns.get("ReadingUsersTable")
        if not users_arn:
            raise HarnessError("users table was not validated")
        self._validate_table("ReadingUsersTable", expected_arn=users_arn)
        users_tags = self._call("dynamodb", "list_tags_of_resource", ResourceArn=users_arn).get("Tags", [])
        self._validate_resource_tags("ReadingUsersTable", _safe_tags(users_tags))
        configurations = self._load_function_configurations(
            ("ReadingRequestFunction", "ReadingStatusFunction")
        )
        request_env = configurations["ReadingRequestFunction"].get("Environment", {}).get("Variables", {})
        status_env = configurations["ReadingStatusFunction"].get("Environment", {}).get("Variables", {})
        if request_env.get("READING_GENERATE_API_ENABLED") != "true" or request_env.get("READING_ASYNC_PAID_ENABLED") != "false":
            raise HarnessError("request Lambda switches are invalid")
        if status_env.get("READING_STATUS_API_ENABLED") != "true":
            raise HarnessError("status Lambda switch is invalid")
        current_session_secret, _kms_key_arn = self._validate_api_secret_and_kms(configurations)
        if not hmac.compare_digest(expected_session_secret, current_session_secret):
            raise HarnessError("Lambda session secret changed before write")

    @staticmethod
    def _error_code(error: Exception) -> str | None:
        response = getattr(error, "response", None)
        if not isinstance(response, dict):
            return None
        error_value = response.get("Error")
        return error_value.get("Code") if isinstance(error_value, dict) else None

    def put_test_user(
        self,
        item: dict[str, Any],
        fixture_password: str,
        password_matches: Any,
        session_secret: str,
    ) -> bool:
        if self._put_attempted or item.get("user_id") != {"S": TEST_USER_ID}:
            raise HarnessError("test user write scope was exceeded")
        self._put_attempted = True
        self._pre_write_revalidate(session_secret)
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

    def _metric_snapshot(self, started_at: float, observed_until: float) -> dict[str, dict[str, Any]]:
        if (
            not isinstance(started_at, (int, float))
            or not isinstance(observed_until, (int, float))
            or not math.isfinite(started_at)
            or not math.isfinite(observed_until)
            or observed_until < started_at
        ):
            raise HarnessError("invocation metric time window was invalid")
        start = datetime.fromtimestamp(started_at, timezone.utc)
        end = datetime.fromtimestamp(max(observed_until, started_at + 1), timezone.utc)
        if start.tzinfo != timezone.utc or end.tzinfo != timezone.utc or end <= start:
            raise HarnessError("invocation metric UTC window was invalid")
        evidence: dict[str, dict[str, Any]] = {}
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
            if not isinstance(datapoints, list):
                evidence[logical_id] = _classify_invocation_values(None)
            else:
                sums = [point.get("Sum") for point in datapoints if isinstance(point, dict)]
                if len(sums) != len(datapoints):
                    evidence[logical_id] = _classify_invocation_values(None)
                else:
                    evidence[logical_id] = _classify_invocation_values(sums)
        expression = "SUM(SEARCH('{AWS/Bedrock} MetricName=\"Invocations\"', 'Sum', 60))"
        metric = self._call(
            "cloudwatch",
            "get_metric_data",
            MetricDataQueries=[
                {
                    "Id": "bedrockinvocations",
                    "Expression": expression,
                    "ReturnData": True,
                }
            ],
            StartTime=start,
            EndTime=end,
            ScanBy="TimestampAscending",
        )
        results = metric.get("MetricDataResults")
        if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
            evidence["Bedrock"] = _classify_invocation_values(None)
        else:
            result = results[0]
            evidence["Bedrock"] = _classify_invocation_values(
                result.get("Values"),
                query_status=result.get("StatusCode", ""),
                uses_fill="FILL(" in expression.upper(),
            )
        return evidence

    def _revalidate_deterministic_controls(self, expected_state: dict[str, Any]) -> None:
        self.validate_boundary()
        session_secret = self.validate_runtime()
        session_secret = ""
        if self.side_effect_state() != expected_state:
            raise HarnessError("deterministic controls changed after API smoke")

    def validate_no_worker_or_bedrock_invocations(
        self,
        started_at: float,
        finished_at: float,
        expected_state: dict[str, Any],
    ) -> dict[str, Any]:
        if finished_at < started_at:
            raise HarnessError("API smoke time window was invalid")
        deadline = self._clock() + METRIC_MAX_WAIT_SECONDS
        while True:
            observed_until = max(finished_at, self._wall_clock())
            evidence = self._metric_snapshot(started_at, observed_until)
            classifications = {key: value["classification"] for key, value in evidence.items()}
            if any(value == METRIC_QUERY_FAILURE for value in classifications.values()):
                raise HarnessError("invocation metric query failed")
            if any(value == METRIC_MEASURED_NONZERO for value in classifications.values()):
                raise HarnessError("worker or Bedrock invocation was detected")
            if classifications and all(value == METRIC_MEASURED_ZERO for value in classifications.values()):
                self._revalidate_deterministic_controls(expected_state)
                return {
                    "classification": classifications,
                    "measured_sum": {key: value["measured_sum"] for key, value in evidence.items()},
                    "deterministic_controls": "PASS",
                    "evidence_label": EVIDENCE_ZERO_MEASURED,
                }
            if self._clock() >= deadline:
                if not classifications or not all(
                    value in (METRIC_MEASURED_ZERO, METRIC_NO_DATA)
                    for value in classifications.values()
                ):
                    raise HarnessError("invocation metric classification was invalid")
                self._revalidate_deterministic_controls(expected_state)
                return {
                    "classification": classifications,
                    "measured_sum": {key: value["measured_sum"] for key, value in evidence.items()},
                    "deterministic_controls": "PASS",
                    "evidence_label": EVIDENCE_NO_INVOCATION_WITH_CONTROLS,
                }
            self._sleep(METRIC_RETRY_SECONDS)

    def api_base(self) -> str:
        api_id = self._resource("ReadingHttpApi")["PhysicalResourceId"]
        _api_gateway_resource_arn(api_id, expected_api_id=api_id)
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
    session_secret = backend.validate_runtime()
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
            created = backend.put_test_user(item, fixture_password, password_matches, session_secret)
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
        metric_evidence = backend.validate_no_worker_or_bedrock_invocations(
            smoke_started, smoke_finished, after
        )
        return {
            "created": created,
            "post": "PASS",
            "get": "PASS",
            "side_effects": "ZERO",
            "invocation_evidence": metric_evidence,
        }
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
    classifications = result["invocation_evidence"]["classification"].values()
    print(f"invocation_measured_zero_count: {sum(value == METRIC_MEASURED_ZERO for value in classifications)}")
    classifications = result["invocation_evidence"]["classification"].values()
    print(f"invocation_no_data_count: {sum(value == METRIC_NO_DATA for value in classifications)}")
    print(f"deterministic_controls: {result['invocation_evidence']['deterministic_controls']}")
    print(f"invocation_evidence: {result['invocation_evidence']['evidence_label']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
