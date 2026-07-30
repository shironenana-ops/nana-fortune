"""Adapter-level safety tests for the staging CLI harness (no AWS/HTTP)."""

import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "reading_staging_cli_harness_adapter", ROOT / "scripts" / "reading_staging_cli_harness.py"
)
HARNESS = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = HARNESS
SPEC.loader.exec_module(HARNESS)

ACCOUNT = "123456789012"
CONFIG = HARNESS.HarnessConfig(ACCOUNT)


class ConditionalFailure(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class SensitiveClientError(Exception):
    def __init__(self):
        super().__init__(
            "denied arn:aws:sts::999999999999:assumed-role/private-role/session "
            "on arn:aws:apigateway:ap-northeast-1::/apis/private-api"
        )
        self.response = {
            "Error": {"Code": "AccessDeniedException", "Message": str(self)},
            "ResponseMetadata": {"HTTPStatusCode": 403, "RequestId": "private-request-id"},
        }


class FakeClient:
    def __init__(self, service, state):
        self.service = service
        self.state = state

    def __getattr__(self, operation):
        def invoke(**kwargs):
            self.state["calls"].append((self.service, operation, kwargs))
            handler = self.state.get("handlers", {}).get((self.service, operation))
            if handler:
                return handler(kwargs)
            return response_for(self.state, self.service, operation, kwargs)

        return invoke


class FakeSession:
    def __init__(self, state=None, region_name=HARNESS.REGION, profile_name=HARNESS.PROFILE):
        self.region_name = region_name
        self.profile_name = profile_name
        self.state = state or base_state()
        self.created = []

    def client(self, service, region_name=None):
        self.created.append((service, region_name))
        return FakeClient(service, self.state)


def resource_map():
    physical = {
        "ReadingUsersTable": "nana-reading-staging-users",
        "ReadingHistoryTable": "nana-reading-staging-history",
        "ReadingIdempotencyTable": "nana-reading-staging-idempotency",
        "ReadingRateLimitTable": "nana-reading-staging-rate-limit",
        "ReadingDeepQuotaTable": "nana-reading-staging-deep-quota",
        "ReadingJobsTable": "nana-reading-staging-jobs",
        "LightQueue": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/nana-reading-staging-light",
        "DeepQueue": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/nana-reading-staging-deep",
        "LightDeadLetterQueue": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/nana-reading-staging-light-dlq",
        "DeepDeadLetterQueue": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/nana-reading-staging-deep-dlq",
        "LightEventSourceMapping": "11111111-1111-4111-8111-111111111111",
        "DeepEventSourceMapping": "22222222-2222-4222-8222-222222222222",
        "ReadingRequestFunction": "nana-reading-staging-request",
        "ReadingStatusFunction": "nana-reading-staging-status",
        "LightWorkerFunction": "nana-reading-staging-light-worker",
        "DeepWorkerFunction": "nana-reading-staging-deep-worker",
        "ReadingHttpApi": "abc123def4",
        "ReadingRequestIntegration": "request-integration",
        "ReadingStatusIntegration": "status-integration",
    }
    result = {}
    for key, resource_type in HARNESS.EXPECTED_RESOURCE_TYPES.items():
        result[key] = {
            "LogicalResourceId": key,
            "PhysicalResourceId": physical.get(key, f"fixture-{key.lower()}"),
            "ResourceType": resource_type,
            "ResourceStatus": "CREATE_COMPLETE",
        }
    return result


def cloudformation_tags(state, logical_id):
    template = json.loads((ROOT / "infrastructure" / "reading-staging" / "template.json").read_text(encoding="utf-8"))
    raw_tags = template["Resources"][logical_id]["Properties"]["Tags"]
    items = raw_tags.items() if isinstance(raw_tags, dict) else ((item["Key"], item["Value"]) for item in raw_tags)
    result = {
        key: state["parameters"][value["Ref"]]
        if isinstance(value, dict) and set(value) == {"Ref"}
        else value
        for key, value in items
    }
    result.update({
        "aws:cloudformation:stack-id": f"arn:aws:cloudformation:{HARNESS.REGION}:{ACCOUNT}:stack/{HARNESS.STACK_NAME}/fixture",
        "aws:cloudformation:stack-name": HARNESS.STACK_NAME,
        "aws:cloudformation:logical-id": logical_id,
    })
    for key, value in state.get("tag_overrides", {}).get(logical_id, {}).items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = value
    return result


def base_state():
    return {
        "calls": [],
        "handlers": {},
        "identity": {
            "Account": ACCOUNT,
            "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/shirone-staging/fixture",
        },
        "stack_status": "UPDATE_COMPLETE",
        "stack_name": HARNESS.STACK_NAME,
        "stack_tags": {"Project": "nana-fortune", "Environment": "staging"},
        "parameters": {
            **HARNESS.EXPECTED_PARAMETERS,
            "Environment": "staging",
            "Owner": "fixture-owner",
            "CostCenter": "fixture-cost-center",
        },
        "resources": resource_map(),
        "lambda_state": "Active",
        "lambda_update": "Successful",
        "request_generate": "true",
        "request_async": "false",
        "status_enabled": "true",
        "bedrock_enabled": "false",
        "esm_state": "Disabled",
        "queue_counts": ("0", "0", "0"),
        "route_targets": {
            "POST /reading": "integrations/request-integration",
            "GET /reading/status": "integrations/status-integration",
        },
        "route_response_overrides": {},
        "integration_overrides": {},
        "route_id_overrides": {},
        "lambda_name_override": None,
        "esm_uuid_override": None,
        "queue_arn_override": None,
        "api_id_override": None,
        "api_protocol": "HTTP",
        "api_name_override": None,
        "api_endpoint_override": None,
        "tag_overrides": {},
        "request_secret": "unit-session-secret-that-is-long-enough-only",
        "status_secret": "unit-session-secret-that-is-long-enough-only",
        "request_kms": None,
        "status_kms": None,
        "items": {},
        "worker_datapoints": [{"Sum": 0.0}],
        "bedrock_results": [{"Id": "bedrockinvocations", "StatusCode": "Complete", "Values": [0.0]}],
    }


def response_for(state, service, operation, kwargs):
    resources = state["resources"]
    if (service, operation) == ("sts", "get_caller_identity"):
        return state["identity"]
    if (service, operation) == ("cloudformation", "describe_stacks"):
        return {
            "Stacks": [
                {
                    "StackName": state["stack_name"],
                    "StackStatus": state["stack_status"],
                    "StackId": f"arn:aws:cloudformation:{HARNESS.REGION}:{ACCOUNT}:stack/{HARNESS.STACK_NAME}/fixture",
                    "Tags": [{"Key": key, "Value": value} for key, value in state["stack_tags"].items()],
                    "Parameters": [
                        {"ParameterKey": key, "ParameterValue": value}
                        for key, value in state["parameters"].items()
                    ],
                }
            ]
        }
    if (service, operation) == ("cloudformation", "list_stack_resources"):
        return {"StackResourceSummaries": list(resources.values())}
    if (service, operation) == ("lambda", "get_function_configuration"):
        name = kwargs["FunctionName"]
        env = {}
        if name.endswith("request"):
            env = {
                "READING_GENERATE_API_ENABLED": state["request_generate"],
                "READING_ASYNC_PAID_ENABLED": state["request_async"],
            }
            if state["request_secret"] is not None:
                env["SESSION_TOKEN_SECRET"] = state["request_secret"]
        elif name.endswith("status"):
            env = {
                "READING_STATUS_API_ENABLED": state["status_enabled"],
            }
            if state["status_secret"] is not None:
                env["SESSION_TOKEN_SECRET"] = state["status_secret"]
        else:
            env = {"READING_BEDROCK_ENABLED": state["bedrock_enabled"]}
        result = {
            "FunctionName": state["lambda_name_override"] or name,
            "State": state["lambda_state"],
            "LastUpdateStatus": state["lambda_update"],
            "FunctionArn": f"arn:aws:lambda:{HARNESS.REGION}:{ACCOUNT}:function:{name}",
            "Environment": {"Variables": env},
        }
        kms = state["request_kms"] if name.endswith("request") else state["status_kms"] if name.endswith("status") else None
        if kms is not None:
            result["KMSKeyArn"] = kms
        return result
    if (service, operation) == ("lambda", "list_tags"):
        function_name = kwargs["Resource"].rsplit(":", 1)[-1]
        logical_id = next(
            key for key in HARNESS.FUNCTION_LOGICAL_IDS if resources[key]["PhysicalResourceId"] == function_name
        )
        return {"Tags": cloudformation_tags(state, logical_id)}
    if (service, operation) == ("lambda", "get_event_source_mapping"):
        return {"State": state["esm_state"], "UUID": state["esm_uuid_override"] or kwargs["UUID"]}
    if (service, operation) == ("sqs", "get_queue_attributes"):
        visible, inflight, delayed = state["queue_counts"]
        return {
            "Attributes": {
                "QueueArn": state["queue_arn_override"] or f"arn:aws:sqs:{HARNESS.REGION}:{ACCOUNT}:{kwargs['QueueUrl'].rsplit('/', 1)[-1]}",
                "ApproximateNumberOfMessages": visible,
                "ApproximateNumberOfMessagesNotVisible": inflight,
                "ApproximateNumberOfMessagesDelayed": delayed,
            }
        }
    if (service, operation) == ("sqs", "list_queue_tags"):
        logical_id = next(
            key for key in HARNESS.QUEUE_LOGICAL_IDS if resources[key]["PhysicalResourceId"] == kwargs["QueueUrl"]
        )
        return {"Tags": cloudformation_tags(state, logical_id)}
    if (service, operation) == ("dynamodb", "describe_table"):
        return {
            "Table": {
                "TableStatus": "ACTIVE",
                "TableArn": f"arn:aws:dynamodb:{HARNESS.REGION}:{ACCOUNT}:table/{kwargs['TableName']}",
            }
        }
    if (service, operation) == ("dynamodb", "list_tags_of_resource"):
        table_name = kwargs["ResourceArn"].rsplit("/", 1)[-1]
        logical_id = next(
            key for key in HARNESS.TABLE_LOGICAL_IDS if resources[key]["PhysicalResourceId"] == table_name
        )
        return {"Tags": [{"Key": key, "Value": value} for key, value in cloudformation_tags(state, logical_id).items()]}
    if (service, operation) == ("apigatewayv2", "get_api"):
        api_id = resources["ReadingHttpApi"]["PhysicalResourceId"]
        return {
            "ApiId": state["api_id_override"] or api_id,
            "ProtocolType": state["api_protocol"],
            "Name": state["api_name_override"] or f"{HARNESS.STACK_NAME}-reading-http-api",
            "ApiEndpoint": state["api_endpoint_override"] or (
                f"https://{api_id}.execute-api.{HARNESS.REGION}.amazonaws.com"
            ),
            "Tags": cloudformation_tags(state, "ReadingHttpApi"),
        }
    if (service, operation) == ("apigatewayv2", "get_route"):
        expected = {
            resources["ReadingRequestRoute"]["PhysicalResourceId"]: "POST /reading",
            resources["ReadingStatusRoute"]["PhysicalResourceId"]: "GET /reading/status",
        }
        route_key = expected[kwargs["RouteId"]]
        overrides = state["route_response_overrides"].get(route_key, {})
        value = {
            "RouteId": state["route_id_overrides"].get(route_key) or kwargs["RouteId"],
            "RouteKey": route_key,
            "Target": state["route_targets"][route_key],
            "AuthorizationType": "NONE",
        }
        if not overrides.get("_omit_managed"):
            value["ApiGatewayManaged"] = False
        value.update({key: item for key, item in overrides.items() if key != "_omit_managed"})
        return value
    if (service, operation) == ("apigatewayv2", "get_integration"):
        integration_id = kwargs["IntegrationId"]
        is_request = integration_id == "request-integration"
        value = {
            "IntegrationId": integration_id,
            "IntegrationType": "AWS_PROXY",
            "IntegrationMethod": "POST",
            "PayloadFormatVersion": "2.0",
            "TimeoutInMillis": 29000 if is_request else 10000,
            "IntegrationUri": f"arn:aws:lambda:{HARNESS.REGION}:{ACCOUNT}:function:nana-reading-staging-{'request' if is_request else 'status'}",
        }
        value.update(state["integration_overrides"])
        return value
    if (service, operation) == ("dynamodb", "get_item"):
        key = tuple(sorted((name, tuple(value.items())) for name, value in kwargs["Key"].items()))
        return {"Item": state["items"][key]} if key in state["items"] else {}
    if (service, operation) == ("dynamodb", "put_item"):
        state["last_put"] = kwargs
        return {}
    if (service, operation) == ("cloudwatch", "get_metric_statistics"):
        return {"Datapoints": state["worker_datapoints"]}
    if (service, operation) == ("cloudwatch", "get_metric_data"):
        return {"MetricDataResults": state["bedrock_results"]}
    raise AssertionError(f"unexpected fake call: {service}/{operation}")


def backend_for(state=None, region_name=HARNESS.REGION, profile_name=HARNESS.PROFILE, **kwargs):
    session = FakeSession(state or base_state(), region_name=region_name, profile_name=profile_name)
    return HARNESS.AwsSdkBackend(CONFIG, session, **kwargs), session


class AdapterBoundaryTests(unittest.TestCase):
    def test_exact_resource_contract_matches_tracked_iac_template(self):
        template = json.loads((ROOT / "infrastructure" / "reading-staging" / "template.json").read_text(encoding="utf-8"))
        actual = {logical_id: resource["Type"] for logical_id, resource in template["Resources"].items()}
        self.assertEqual(actual, HARNESS.EXPECTED_RESOURCE_TYPES)
        self.assertEqual(len(actual), 43)

    def test_aws_client_error_output_is_allow_listed_and_identifier_free(self):
        state = base_state()
        state["handlers"][("sts", "get_caller_identity")] = lambda _kwargs: (_ for _ in ()).throw(
            SensitiveClientError()
        )
        backend, _ = backend_for(state)
        with self.assertRaises(HARNESS.HarnessError) as raised:
            backend.validate_boundary()
        safe_error = raised.exception
        safe_text = str(safe_error)
        self.assertIn("exception_class=SensitiveClientError", safe_text)
        self.assertIn("http_status=403", safe_text)
        self.assertIn("aws_error_code=AccessDeniedException", safe_text)
        for forbidden in (
            "999999999999",
            "assumed-role",
            "private-role",
            "private-api",
            "private-request-id",
            "arn:aws",
        ):
            self.assertNotIn(forbidden, safe_text)

        output = io.StringIO()
        with (
            mock.patch.object(HARNESS, "load_config", return_value=CONFIG),
            mock.patch.object(HARNESS.AwsSdkBackend, "create", side_effect=safe_error),
            redirect_stdout(output),
        ):
            self.assertEqual(
                HARNESS.main(["--execute", "--confirm", HARNESS.CONFIRMATION]),
                1,
            )
        rendered = output.getvalue()
        self.assertIn("STAGING_CLI_HARNESS_FAILED", rendered)
        for forbidden in (
            "999999999999",
            "assumed-role",
            "private-role",
            "private-api",
            "private-request-id",
            "arn:aws",
        ):
            self.assertNotIn(forbidden, rendered)

    def test_api_gateway_resource_arn_is_exact_and_accountless(self):
        api_id = "abc123def4"
        value = HARNESS._api_gateway_resource_arn(api_id, expected_api_id=api_id)
        HARNESS._validate_api_gateway_resource_arn(value, expected_api_id=api_id)
        self.assertEqual(value.split(":", 5)[4], "")
        self.assertEqual(value.split(":", 5)[5], f"/apis/{api_id}")

    def test_api_gateway_resource_arn_rejects_account_execute_api_route_integration_and_id_mismatch(self):
        api_id = "abc123def4"
        invalid = (
            f"arn:aws:apigateway:{HARNESS.REGION}:{ACCOUNT}:/apis/{api_id}",
            f"arn:aws:execute-api:{HARNESS.REGION}:{ACCOUNT}:{api_id}",
            f"arn:aws:apigateway:{HARNESS.REGION}::/apis/{api_id}/routes/route",
            f"arn:aws:apigateway:{HARNESS.REGION}::/apis/{api_id}/integrations/integration",
        )
        for value in invalid:
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS._validate_api_gateway_resource_arn(value, expected_api_id=api_id)
        with self.assertRaises(HARNESS.HarnessError):
            HARNESS._validate_api_gateway_resource_arn(
                f"arn:aws:apigateway:{HARNESS.REGION}::/apis/other123",
                expected_api_id=api_id,
            )

    def test_get_api_is_the_only_api_tag_source_and_requires_exact_identity(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.validate_boundary()
        backend.validate_runtime()
        get_api_calls = [call for call in state["calls"] if call[:2] == ("apigatewayv2", "get_api")]
        get_tags_calls = [call for call in state["calls"] if call[:2] == ("apigatewayv2", "get_tags")]
        self.assertEqual(len(get_api_calls), 1)
        self.assertEqual(get_api_calls[0][2], {"ApiId": state["resources"]["ReadingHttpApi"]["PhysicalResourceId"]})
        self.assertEqual(get_tags_calls, [])

        for key, value in (
            ("api_id_override", "other123"),
            ("api_protocol", "WEBSOCKET"),
            ("api_name_override", "nana-reading-production-http-api"),
            ("api_endpoint_override", "https://production.execute-api.ap-northeast-1.amazonaws.com"),
        ):
            state = base_state()
            state[key] = value
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_get_api_tags_fail_closed_when_missing_or_mismatched(self):
        for overrides in (
            {"Project": None},
            {"Environment": "development"},
            {"Unexpected": "production"},
        ):
            state = base_state()
            state["tag_overrides"]["ReadingHttpApi"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

        state = base_state()
        state["handlers"][("apigatewayv2", "get_api")] = lambda _kwargs: {
            "ApiId": state["resources"]["ReadingHttpApi"]["PhysicalResourceId"],
            "ProtocolType": "HTTP",
            "Name": f"{HARNESS.STACK_NAME}-reading-http-api",
            "ApiEndpoint": (
                f"https://{state['resources']['ReadingHttpApi']['PhysicalResourceId']}"
                f".execute-api.{HARNESS.REGION}.amazonaws.com"
            ),
        }
        backend, _ = backend_for(state)
        backend.validate_boundary()
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_runtime()

    def test_api_gateway_reads_are_exact_individual_calls_only(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.validate_boundary()
        backend.validate_runtime()
        operations = [operation for service, operation, _kwargs in state["calls"] if service == "apigatewayv2"]
        self.assertEqual(operations.count("get_api"), 1)
        self.assertEqual(operations.count("get_route"), 2)
        self.assertEqual(operations.count("get_integration"), 2)
        self.assertEqual(operations.count("get_routes"), 0)
        self.assertEqual(operations.count("get_integrations"), 0)
        self.assertEqual(operations.count("get_tags"), 0)
        route_calls = [kwargs for service, operation, kwargs in state["calls"] if (service, operation) == ("apigatewayv2", "get_route")]
        integration_calls = [kwargs for service, operation, kwargs in state["calls"] if (service, operation) == ("apigatewayv2", "get_integration")]
        self.assertEqual(
            {call["RouteId"] for call in route_calls},
            {state["resources"][logical]["PhysicalResourceId"] for logical in HARNESS.ROUTE_LOGICAL_IDS},
        )
        self.assertEqual(
            {call["IntegrationId"] for call in integration_calls},
            {state["resources"][logical]["PhysicalResourceId"] for logical in HARNESS.INTEGRATION_LOGICAL_IDS},
        )

    def test_stack_mapping_has_exactly_two_routes_and_two_integrations(self):
        self.assertEqual(len(HARNESS.ROUTE_LOGICAL_IDS), 2)
        self.assertEqual(len(HARNESS.INTEGRATION_LOGICAL_IDS), 2)
        for logical_ids in (HARNESS.ROUTE_LOGICAL_IDS, HARNESS.INTEGRATION_LOGICAL_IDS):
            state = base_state()
            state["resources"].pop(logical_ids[-1])
            backend, _ = backend_for(state)
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_boundary()
            state = base_state()
            state["resources"][f"Unexpected{logical_ids[-1]}"] = {
                "LogicalResourceId": f"Unexpected{logical_ids[-1]}",
                "PhysicalResourceId": "unexpected-staging-id",
                "ResourceType": state["resources"][logical_ids[-1]]["ResourceType"],
                "ResourceStatus": "CREATE_COMPLETE",
            }
            backend, _ = backend_for(state)
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_boundary()

    def test_one_session_creates_all_clients_in_fixed_region(self):
        backend, session = backend_for()
        self.assertEqual(set(backend.clients), set(HARNESS.CLIENT_SERVICES))
        self.assertEqual(len(session.created), len(HARNESS.CLIENT_SERVICES))
        self.assertTrue(all(region == HARNESS.REGION for _, region in session.created))

    def test_wrong_profile_or_region_rejected_before_client_creation(self):
        for session in (
            FakeSession(region_name="us-east-1"),
            FakeSession(profile_name="shirone-staging"),
            FakeSession(profile_name="default"),
        ):
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.AwsSdkBackend(CONFIG, session)
            self.assertEqual(session.created, [])

    def test_wrong_account_and_root_are_rejected(self):
        for identity in (
            {"Account": "999999999999", "Arn": "arn:aws:sts::999999999999:assumed-role/test/x"},
            {"Account": ACCOUNT, "Arn": f"arn:aws:iam::{ACCOUNT}:root"},
        ):
            state = base_state()
            state["identity"] = identity
            backend, _ = backend_for(state)
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_boundary()

    def test_stack_status_and_switch_fail_closed_but_stack_tags_are_not_required(self):
        state = base_state()
        state["stack_status"] = "UPDATE_ROLLBACK_COMPLETE"
        backend, _ = backend_for(state)
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_boundary()
        state = base_state()
        state["stack_tags"] = {}
        backend, _ = backend_for(state)
        backend.validate_boundary()
        state = base_state()
        state["parameters"]["ReadingBedrockEnabled"] = "true"
        backend, _ = backend_for(state)
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_boundary()

    def test_stack_name_and_resource_physical_ids_reject_production_identifiers(self):
        state = base_state()
        state["stack_name"] = "other-staging-stack"
        backend, _ = backend_for(state)
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_boundary()
        state = base_state()
        state["resources"]["ReadingRequestFunction"]["PhysicalResourceId"] = "nana-reading-production-request"
        backend, _ = backend_for(state)
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_boundary()

    def test_resource_inventory_requires_exact_32_logical_ids_types_and_statuses(self):
        for mutate in ("missing", "extra", "type", "status"):
            state = base_state()
            if mutate == "missing":
                state["resources"].pop("ReadingApiStage")
            elif mutate == "extra":
                state["resources"]["UnexpectedResource"] = {
                    "LogicalResourceId": "UnexpectedResource",
                    "PhysicalResourceId": "unexpected",
                    "ResourceType": "AWS::S3::Bucket",
                    "ResourceStatus": "CREATE_COMPLETE",
                }
            elif mutate == "type":
                state["resources"]["ReadingUsersTable"]["ResourceType"] = "AWS::S3::Bucket"
            else:
                state["resources"]["ReadingUsersTable"]["ResourceStatus"] = "DELETE_COMPLETE"
            backend, _ = backend_for(state)
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_boundary()

    def test_logical_to_physical_mapping_change_fails_closed_on_revalidation(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.validate_boundary()
        state["resources"]["ReadingUsersTable"] = {
            **state["resources"]["ReadingUsersTable"],
            "PhysicalResourceId": "other-staging-users",
        }
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_boundary()

    def test_esm_enabled_and_nonempty_queue_fail_closed(self):
        for key, value in (("esm_state", "Enabled"), ("queue_counts", ("1", "0", "0"))):
            state = base_state()
            state[key] = value
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_explicit_project_and_environment_tags_are_required(self):
        for logical_id in ("ReadingUsersTable", "LightQueue", "ReadingRequestFunction", "ReadingHttpApi"):
            for key in ("Project", "Environment"):
                state = base_state()
                state["tag_overrides"][logical_id] = {key: None}
                backend, _ = backend_for(state)
                backend.validate_boundary()
                with self.assertRaises(HARNESS.HarnessError):
                    backend.validate_runtime()

    def test_all_explicit_template_tags_are_required(self):
        for logical_id in ("ReadingUsersTable", "LightQueue", "ReadingRequestFunction", "ReadingHttpApi"):
            state = base_state()
            state["tag_overrides"][logical_id] = {"Component": None}
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_dynamodb_and_sqs_allow_absent_cloudformation_generated_tags(self):
        for logical_id in ("ReadingUsersTable", "LightQueue"):
            state = base_state()
            state["tag_overrides"][logical_id] = {
                "aws:cloudformation:stack-id": None,
                "aws:cloudformation:stack-name": None,
                "aws:cloudformation:logical-id": None,
            }
            backend, _ = backend_for(state)
            backend.validate_boundary()
            backend.validate_runtime()

    def test_cloudformation_generated_tags_fail_closed_only_when_present_and_wrong(self):
        for logical_id in ("ReadingUsersTable", "LightQueue", "ReadingRequestFunction", "ReadingHttpApi"):
            state = base_state()
            state["tag_overrides"][logical_id] = {"aws:cloudformation:logical-id": "WrongLogicalId"}
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_custom_tag_not_declared_by_template_is_not_required(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.validate_boundary()
        backend.validate_runtime()
        self.assertNotIn("Purpose", cloudformation_tags(state, "ReadingUsersTable"))

    def test_resource_tag_production_identifier_fails_closed(self):
        state = base_state()
        state["tag_overrides"]["ReadingUsersTable"] = {"Unexpected": "production"}
        backend, _ = backend_for(state)
        backend.validate_boundary()
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_runtime()

    def test_lambda_queue_esm_and_route_physical_ids_must_match(self):
        mutations = (
            ("lambda_name_override", "other-staging-function"),
            ("queue_arn_override", f"arn:aws:sqs:{HARNESS.REGION}:{ACCOUNT}:other-staging-queue"),
            ("esm_uuid_override", "99999999-9999-4999-8999-999999999999"),
        )
        for key, value in mutations:
            state = base_state()
            state[key] = value
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()
        state = base_state()
        state["route_id_overrides"]["POST /reading"] = "other-route"
        backend, _ = backend_for(state)
        backend.validate_boundary()
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_runtime()

    def test_route_targets_must_match_exact_integration_ids(self):
        for target in (None, "integrations/status-integration", "prefix/integrations/request-integration"):
            state = base_state()
            state["route_targets"]["POST /reading"] = target
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with mock.patch.object(HARNESS, "_request_json") as request:
                with self.assertRaises(HARNESS.HarnessError):
                    backend.validate_runtime()
            request.assert_not_called()

    def test_individual_route_response_shape_must_match_exactly(self):
        for overrides in (
            {"RouteId": "other-route"},
            {"RouteKey": "POST /other"},
            {"Target": "integrations/other-integration"},
            {"AuthorizationType": "AWS_IAM"},
            {"ApiGatewayManaged": True},
        ):
            state = base_state()
            state["route_response_overrides"]["POST /reading"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_route_managed_flag_accepts_only_omitted_or_boolean_false(self):
        for overrides in ({"_omit_managed": True}, {"ApiGatewayManaged": False}):
            state = base_state()
            state["route_response_overrides"]["POST /reading"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            backend.validate_runtime()
        for value in (True, "false", 0, None):
            state = base_state()
            state["route_response_overrides"]["POST /reading"] = {"ApiGatewayManaged": value}
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_integration_shape_mismatch_fails_closed(self):
        for overrides in (
            {"IntegrationId": "other-integration"},
            {"IntegrationUri": "arn:aws:lambda:ap-northeast-1:123456789012:function:other"},
            {"PayloadFormatVersion": "1.0"},
            {"TimeoutInMillis": 1},
            {"TimeoutInMillis": 29000},
            {"RequestParameters": {"overwrite:path": "/reading"}},
        ):
            state = base_state()
            state["integration_overrides"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_integration_managed_flag_accepts_only_omitted_or_boolean_false(self):
        for overrides in ({}, {"ApiGatewayManaged": False}):
            state = base_state()
            state["integration_overrides"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            backend.validate_runtime()
        for value in (True, "false", 0, None):
            state = base_state()
            state["integration_overrides"] = {"ApiGatewayManaged": value}
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_request_and_status_lambda_secret_must_exist_and_match(self):
        for mutate in ("request_missing", "status_missing", "request_empty", "status_empty", "mismatch"):
            state = base_state()
            if mutate == "request_missing":
                state["request_secret"] = None
            elif mutate == "status_missing":
                state["status_secret"] = None
            elif mutate == "request_empty":
                state["request_secret"] = ""
            elif mutate == "status_empty":
                state["status_secret"] = ""
            else:
                state["status_secret"] = "different"
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError) as raised:
                backend.validate_runtime()
            self.assertNotIn("unit-session-secret", str(raised.exception))
            self.assertNotIn("different", str(raised.exception))

    def test_lambda_kms_key_is_optional_but_must_match_staging_boundary(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.validate_boundary()
        self.assertEqual(backend.validate_runtime(), state["request_secret"])

        valid_kms = f"arn:aws:kms:{HARNESS.REGION}:{ACCOUNT}:key/11111111-1111-4111-8111-111111111111"
        state = base_state()
        state["request_kms"] = valid_kms
        state["status_kms"] = valid_kms
        backend, _ = backend_for(state)
        backend.validate_boundary()
        self.assertEqual(backend.validate_runtime(), state["request_secret"])

        for request_kms, status_kms in (
            (valid_kms, None),
            (valid_kms, valid_kms.replace(ACCOUNT, "999999999999")),
            (valid_kms, valid_kms.replace(HARNESS.REGION, "us-east-1")),
        ):
            state = base_state()
            state["request_kms"] = request_kms
            state["status_kms"] = status_kms
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_no_secrets_manager_client_or_call_is_created(self):
        state = base_state()
        backend, session = backend_for(state)
        backend.validate_boundary()
        backend.validate_runtime()
        self.assertNotIn("secretsmanager", backend.clients)
        self.assertNotIn(("secretsmanager", HARNESS.REGION), session.created)
        self.assertFalse(any(service == "secretsmanager" for service, _operation, _kwargs in state["calls"]))


class AdapterWriteAndMetricTests(unittest.TestCase):
    def prepared(self, state=None, **kwargs):
        backend, session = backend_for(state, **kwargs)
        backend.validate_boundary()
        session_secret = backend.validate_runtime()
        return backend, session, session_secret

    def test_conditional_put_race_reloads_consistently_and_accepts_exact_fixture(self):
        state = base_state()
        backend, _, session_secret = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["request_secret"])
        item = {
            "user_id": {"S": HARNESS.TEST_USER_ID},
            "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
            "plan": {"S": "light"},
            "subscription_status": {"S": "active"},
        }
        key = (("user_id", (("S", HARNESS.TEST_USER_ID),)),)
        state["items"][key] = item
        state["handlers"][("dynamodb", "put_item")] = lambda _kwargs: (_ for _ in ()).throw(ConditionalFailure())
        self.assertFalse(backend.put_test_user(item, fixture_password, password_matches, session_secret))
        get_calls = [call for call in state["calls"] if call[:2] == ("dynamodb", "get_item")]
        self.assertTrue(get_calls[-1][2]["ConsistentRead"])

    def test_conditional_put_race_rejects_mismatched_fixture(self):
        state = base_state()
        backend, _, session_secret = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["request_secret"])
        requested = {
            "user_id": {"S": HARNESS.TEST_USER_ID},
            "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
            "plan": {"S": "light"},
            "subscription_status": {"S": "active"},
        }
        existing = dict(requested)
        existing["plan"] = {"S": "premium"}
        key = (("user_id", (("S", HARNESS.TEST_USER_ID),)),)
        state["items"][key] = existing
        state["handlers"][("dynamodb", "put_item")] = lambda _kwargs: (_ for _ in ()).throw(ConditionalFailure())
        with self.assertRaises(HARNESS.HarnessError):
            backend.put_test_user(requested, fixture_password, password_matches, session_secret)

    def test_prewrite_rechecks_identity_table_lambda_secret_and_stack(self):
        state = base_state()
        backend, _, session_secret = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["request_secret"])
        item = {
            "user_id": {"S": HARNESS.TEST_USER_ID},
            "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
            "plan": {"S": "light"},
            "subscription_status": {"S": "active"},
        }
        self.assertTrue(backend.put_test_user(item, fixture_password, password_matches, session_secret))
        calls = [(service, operation) for service, operation, _ in state["calls"]]
        self.assertGreaterEqual(calls.count(("sts", "get_caller_identity")), 2)
        self.assertGreaterEqual(calls.count(("cloudformation", "describe_stacks")), 2)
        self.assertGreaterEqual(calls.count(("dynamodb", "describe_table")), 7)
        self.assertGreaterEqual(calls.count(("lambda", "get_function_configuration")), 6)
        self.assertNotIn(("secretsmanager", "describe_secret"), calls)

    def test_metric_real_shapes_confirm_zero_and_reject_activity(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.resources = state["resources"]
        self.assertEqual(
            backend._metric_snapshot(1_700_000_000, 1_700_000_010),
            {
                "LightWorkerFunction": {"classification": "MEASURED_ZERO", "measured_sum": 0.0},
                "DeepWorkerFunction": {"classification": "MEASURED_ZERO", "measured_sum": 0.0},
                "Bedrock": {"classification": "MEASURED_ZERO", "measured_sum": 0.0},
            },
        )
        state["worker_datapoints"] = [{"Timestamp": "fixture", "Sum": 1.0}]
        snapshot = backend._metric_snapshot(1_700_000_000, 1_700_000_010)
        self.assertEqual(snapshot["LightWorkerFunction"]["classification"], "MEASURED_NONZERO")
        backend, _ = backend_for(
            state,
            clock=lambda: 0.0,
            wall_clock=lambda: 1_700_000_020,
            sleeper=lambda _seconds: None,
        )
        backend.validate_boundary()
        backend.validate_runtime()
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_no_worker_or_bedrock_invocations(
                1_700_000_000, 1_700_000_010, backend.side_effect_state()
            )

    def test_cloudwatch_empty_with_all_controls_uses_sparse_metric_evidence(self):
        state = base_state()
        state["worker_datapoints"] = []
        state["bedrock_results"] = [{"Id": "bedrockinvocations", "StatusCode": "Complete", "Values": []}]
        ticks = iter((0.0, 301.0))
        backend, _ = backend_for(
            state,
            clock=lambda: next(ticks),
            wall_clock=lambda: 1_700_000_020,
            sleeper=lambda _seconds: None,
        )
        backend.validate_boundary()
        backend.validate_runtime()
        expected_state = backend.side_effect_state()
        snapshot = backend._metric_snapshot(1_700_000_000, 1_700_000_010)
        self.assertTrue(all(value["classification"] == "NO_DATA" for value in snapshot.values()))
        evidence = backend.validate_no_worker_or_bedrock_invocations(
            1_700_000_000, 1_700_000_010, expected_state
        )
        self.assertEqual(
            evidence["evidence_label"],
            "NO_INVOCATION_OBSERVED_WITH_DETERMINISTIC_CONTROLS",
        )
        self.assertEqual(evidence["deterministic_controls"], "PASS")
        self.assertTrue(all(value is None for value in evidence["measured_sum"].values()))

    def test_sparse_metric_evidence_fails_when_switch_esm_queue_or_ddb_changes(self):
        mutations = (
            lambda state: state.update(request_async="true"),
            lambda state: state.update(esm_state="Enabled"),
            lambda state: state.update(queue_counts=("1", "0", "0")),
            lambda state: state["items"].update({(("job_ref", (("S", HARNESS.MISSING_JOB_REF),)),): {"job_ref": {"S": HARNESS.MISSING_JOB_REF}}}),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                state = base_state()
                state["worker_datapoints"] = []
                state["bedrock_results"] = [
                    {"Id": "bedrockinvocations", "StatusCode": "Complete", "Values": []}
                ]
                ticks = iter((0.0, 301.0))
                backend, _ = backend_for(
                    state,
                    clock=lambda: next(ticks),
                    wall_clock=lambda: 1_700_000_020,
                    sleeper=lambda _seconds: None,
                )
                backend.validate_boundary()
                backend.validate_runtime()
                expected_state = backend.side_effect_state()
                mutate(state)
                with self.assertRaises(HARNESS.HarnessError):
                    backend.validate_no_worker_or_bedrock_invocations(
                        1_700_000_000, 1_700_000_010, expected_state
                    )

    def test_partial_query_error_fill_and_invalid_window_fail_closed(self):
        self.assertEqual(
            HARNESS._classify_invocation_values([0.0], uses_fill=True)["classification"],
            "QUERY_FAILURE",
        )
        state = base_state()
        state["bedrock_results"] = [
            {"Id": "bedrockinvocations", "StatusCode": "PartialData", "Values": [0.0]}
        ]
        backend, _ = backend_for(state)
        backend.resources = state["resources"]
        snapshot = backend._metric_snapshot(1_700_000_000, 1_700_000_010)
        self.assertEqual(snapshot["Bedrock"]["classification"], "QUERY_FAILURE")
        with self.assertRaises(HARNESS.HarnessError):
            backend._metric_snapshot(1_700_000_010, 1_700_000_000)

        state = base_state()
        state["handlers"][("cloudwatch", "get_metric_statistics")] = lambda _kwargs: (_ for _ in ()).throw(
            SensitiveClientError()
        )
        backend, _ = backend_for(state)
        backend.resources = state["resources"]
        with self.assertRaises(HARNESS.HarnessError):
            backend._metric_snapshot(1_700_000_000, 1_700_000_010)

    def test_metric_query_window_is_utc_and_contains_api_smoke(self):
        state = base_state()
        backend, session = backend_for(state)
        backend.resources = state["resources"]
        backend._metric_snapshot(1_700_000_000, 1_700_000_020)
        calls = [call for call in state["calls"] if call[0] == "cloudwatch"]
        self.assertEqual(len(calls), 3)
        for _service, _operation, kwargs in calls:
            self.assertEqual(kwargs["StartTime"].tzinfo, HARNESS.timezone.utc)
            self.assertEqual(kwargs["EndTime"].tzinfo, HARNESS.timezone.utc)
            self.assertLessEqual(kwargs["StartTime"].timestamp(), 1_700_000_000)
            self.assertGreaterEqual(kwargs["EndTime"].timestamp(), 1_700_000_020)


class AdapterLocalSafetyTests(unittest.TestCase):
    def test_dry_run_constructs_no_session_client_or_subprocess(self):
        with mock.patch.object(HARNESS, "_load_session_factory", side_effect=AssertionError("no session")), mock.patch(
            "urllib.request.build_opener", side_effect=AssertionError("no HTTP")
        ):
            self.assertEqual(HARNESS.main([]), 0)

    def test_create_uses_exact_profile_and_region_without_environment_token(self):
        state = base_state()
        captured = {}

        def factory(**kwargs):
            captured.update(kwargs)
            return FakeSession(state)

        with mock.patch.object(HARNESS, "_load_session_factory", return_value=factory):
            backend = HARNESS.AwsSdkBackend.create(CONFIG)
        self.assertIsNotNone(backend)
        self.assertEqual(captured, {"profile_name": HARNESS.PROFILE, "region_name": HARNESS.REGION})
        self.assertNotIn("SHIRONE_STAGING_SESSION_TOKEN", HARNESS.os.environ)

    def test_redirect_is_refused_instead_of_forwarding_authorization(self):
        handler = HARNESS._NoRedirect()
        with self.assertRaises(HARNESS.HarnessError):
            handler.redirect_request(None, None, 302, "fixture", {}, "https://other.invalid/")

if __name__ == "__main__":
    unittest.main()
