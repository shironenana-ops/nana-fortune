"""Adapter-level safety tests for the staging CLI harness (no AWS/HTTP)."""

import importlib.util
import json
import sys
import unittest
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
SECRET_ARN = f"arn:aws:secretsmanager:{HARNESS.REGION}:{ACCOUNT}:secret:nana-reading-staging-runtime-AbCd"
CONFIG = HARNESS.HarnessConfig(ACCOUNT, SECRET_ARN)


class ConditionalFailure(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}


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
    result = {
        "Project": "nana-fortune",
        "Environment": "staging",
        "aws:cloudformation:stack-id": f"arn:aws:cloudformation:{HARNESS.REGION}:{ACCOUNT}:stack/{HARNESS.STACK_NAME}/fixture",
        "aws:cloudformation:stack-name": HARNESS.STACK_NAME,
        "aws:cloudformation:logical-id": logical_id,
    }
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
        "parameters": dict(HARNESS.EXPECTED_PARAMETERS),
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
        "integration_overrides": {},
        "route_id_overrides": {},
        "lambda_name_override": None,
        "esm_uuid_override": None,
        "queue_arn_override": None,
        "tag_overrides": {},
        "secret_arn": SECRET_ARN,
        "secret_tags": {"Project": "nana-fortune", "Environment": "staging"},
        "secret": "unit-session-secret-that-is-long-enough-only",
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
                "SESSION_TOKEN_SECRET": state["secret"],
            }
        elif name.endswith("status"):
            env = {
                "READING_STATUS_API_ENABLED": state["status_enabled"],
                "SESSION_TOKEN_SECRET": state["secret"],
            }
        else:
            env = {"READING_BEDROCK_ENABLED": state["bedrock_enabled"]}
        return {
            "FunctionName": state["lambda_name_override"] or name,
            "State": state["lambda_state"],
            "LastUpdateStatus": state["lambda_update"],
            "FunctionArn": f"arn:aws:lambda:{HARNESS.REGION}:{ACCOUNT}:function:{name}",
            "Environment": {"Variables": env},
        }
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
        return {"Tags": [{"Key": key, "Value": value} for key, value in cloudformation_tags(state, "ReadingUsersTable").items()]}
    if (service, operation) == ("apigatewayv2", "get_routes"):
        return {
            "Items": [
                {
                    "RouteKey": route,
                    "RouteId": state["route_id_overrides"].get(route) or resources["ReadingRequestRoute" if route == "POST /reading" else "ReadingStatusRoute"]["PhysicalResourceId"],
                    "Target": target,
                }
                for route, target in state["route_targets"].items()
            ]
        }
    if (service, operation) == ("apigatewayv2", "get_tags"):
        return {"Tags": cloudformation_tags(state, "ReadingHttpApi")}
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
    if (service, operation) == ("secretsmanager", "describe_secret"):
        return {
            "ARN": state["secret_arn"],
            "Tags": [{"Key": key, "Value": value} for key, value in state["secret_tags"].items()],
        }
    if (service, operation) == ("secretsmanager", "get_secret_value"):
        return {"SecretString": '{"session_token_secret":"' + state["secret"] + '"}'}
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
        self.assertEqual(len(actual), 32)

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

    def test_esm_enabled_and_nonempty_queue_fail_closed(self):
        for key, value in (("esm_state", "Enabled"), ("queue_counts", ("1", "0", "0"))):
            state = base_state()
            state[key] = value
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_resource_level_staging_and_cloudformation_tags_are_required(self):
        for logical_id in ("ReadingUsersTable", "ReadingRequestFunction", "ReadingHttpApi"):
            state = base_state()
            state["tag_overrides"][logical_id] = {"aws:cloudformation:stack-id": None}
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_sqs_requires_explicit_tags_but_not_unavailable_cloudformation_tags(self):
        state = base_state()
        state["tag_overrides"]["LightQueue"] = {
            "aws:cloudformation:stack-id": None,
            "aws:cloudformation:stack-name": None,
            "aws:cloudformation:logical-id": None,
        }
        backend, _ = backend_for(state)
        backend.validate_boundary()
        backend.validate_runtime()
        for key in ("Project", "Environment"):
            state = base_state()
            state["tag_overrides"]["LightQueue"] = {key: None}
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

    def test_integration_shape_mismatch_fails_closed(self):
        for overrides in (
            {"IntegrationUri": "arn:aws:lambda:ap-northeast-1:123456789012:function:other"},
            {"PayloadFormatVersion": "1.0"},
            {"TimeoutInMillis": 1},
            {"RequestParameters": {"overwrite:path": "/reading"}},
        ):
            state = base_state()
            state["integration_overrides"] = overrides
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_runtime()

    def test_secret_account_region_and_tags_fail_closed(self):
        for mutate in ("account", "region", "tag"):
            state = base_state()
            if mutate == "account":
                state["secret_arn"] = SECRET_ARN.replace(ACCOUNT, "999999999999")
            elif mutate == "region":
                state["secret_arn"] = SECRET_ARN.replace(HARNESS.REGION, "us-east-1")
            else:
                state["secret_tags"]["Environment"] = "production"
            backend, _ = backend_for(state)
            backend.validate_boundary()
            with self.assertRaises(HARNESS.HarnessError):
                backend.validate_secret_and_get_session_secret()


class AdapterWriteAndMetricTests(unittest.TestCase):
    def prepared(self, state=None, **kwargs):
        backend, session = backend_for(state, **kwargs)
        backend.validate_boundary()
        backend.validate_runtime()
        return backend, session

    def test_conditional_put_race_reloads_consistently_and_accepts_exact_fixture(self):
        state = base_state()
        backend, _ = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["secret"])
        item = {
            "user_id": {"S": HARNESS.TEST_USER_ID},
            "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
            "plan": {"S": "light"},
            "subscription_status": {"S": "active"},
        }
        key = (("user_id", (("S", HARNESS.TEST_USER_ID),)),)
        state["items"][key] = item
        state["handlers"][("dynamodb", "put_item")] = lambda _kwargs: (_ for _ in ()).throw(ConditionalFailure())
        self.assertFalse(backend.put_test_user(item, fixture_password, password_matches))
        get_calls = [call for call in state["calls"] if call[:2] == ("dynamodb", "get_item")]
        self.assertTrue(get_calls[-1][2]["ConsistentRead"])

    def test_conditional_put_race_rejects_mismatched_fixture(self):
        state = base_state()
        backend, _ = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["secret"])
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
            backend.put_test_user(requested, fixture_password, password_matches)

    def test_prewrite_rechecks_identity_table_secret_and_stack(self):
        state = base_state()
        backend, _ = self.prepared(state)
        password_hash, password_matches, _ = HARNESS._lambda_imports()
        fixture_password = HARNESS._fixture_password(state["secret"])
        item = {
            "user_id": {"S": HARNESS.TEST_USER_ID},
            "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
            "plan": {"S": "light"},
            "subscription_status": {"S": "active"},
        }
        self.assertTrue(backend.put_test_user(item, fixture_password, password_matches))
        calls = [(service, operation) for service, operation, _ in state["calls"]]
        self.assertGreaterEqual(calls.count(("sts", "get_caller_identity")), 2)
        self.assertGreaterEqual(calls.count(("cloudformation", "describe_stacks")), 2)
        self.assertGreaterEqual(calls.count(("dynamodb", "describe_table")), 7)
        self.assertIn(("secretsmanager", "describe_secret"), calls)

    def test_metric_real_shapes_confirm_zero_and_reject_activity(self):
        state = base_state()
        backend, _ = backend_for(state)
        backend.resources = state["resources"]
        self.assertEqual(
            backend._metric_snapshot(1_700_000_000, 1_700_000_010),
            {
                "LightWorkerFunction": "ZERO_CONFIRMED",
                "DeepWorkerFunction": "ZERO_CONFIRMED",
                "Bedrock": "ZERO_CONFIRMED",
            },
        )
        state["worker_datapoints"] = [{"Timestamp": "fixture", "Sum": 1.0}]
        with self.assertRaises(HARNESS.HarnessError):
            backend._metric_snapshot(1_700_000_000, 1_700_000_010)

    def test_cloudwatch_empty_is_no_data_and_deadline_fails_closed(self):
        state = base_state()
        state["worker_datapoints"] = []
        state["bedrock_results"] = [{"Id": "bedrockinvocations", "StatusCode": "Complete", "Values": []}]
        ticks = iter((0.0, 301.0))
        backend, _ = backend_for(state, clock=lambda: next(ticks), sleeper=lambda _seconds: None)
        backend.resources = state["resources"]
        snapshot = backend._metric_snapshot(1_700_000_000, 1_700_000_010)
        self.assertTrue(all(value == "NO_DATA" for value in snapshot.values()))
        with self.assertRaises(HARNESS.HarnessError):
            backend.validate_no_worker_or_bedrock_invocations(1_700_000_000, 1_700_000_010)


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
