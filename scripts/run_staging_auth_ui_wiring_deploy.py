"""Repair the staging Runtime Secret and deploy auth/UI wiring safely.

Secret values are kept inside this process only.  This script never reports,
persists, hashes, or exports them.  It is intentionally staging/account bound.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from staging_runtime_secret_contract import (
    CANONICAL_KEYS,
    RuntimeSecretContractError,
    assert_secret_boundary,
    canonical_keys_present,
    extract_webhook_signature,
    merge_runtime_secret,
    normalized_webhook_secret,
    resolve_canonical_values,
)


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
EXPECTED_ACCOUNT = "946385207519"
STACK = "nana-reading-staging"
PROJECT = "nana-fortune"
ENVIRONMENT = "staging"
REPO = Path(__file__).resolve().parents[1]
TEMP_DIR = Path.home() / "AppData" / "Local" / "Temp" / "nana-auth-ui-wiring-20260804"
PARAMETER_FILE = TEMP_DIR / "change-set-parameters.json"

CONSUMER_LOGICAL_IDS = (
    "ReadingRequestFunction",
    "ReadingStatusFunction",
    "LightWorkerFunction",
    "DeepWorkerFunction",
)
AUTH_LOGICAL_IDS = (
    "StagingLoginFunction",
    "StagingSignupFunction",
    "StagingMembershipStatusFunction",
)
AUTH_ROUTES = {"POST /login", "POST /signup", "GET /membership/status"}
EVENT_SOURCE_LOGICAL_IDS = ("LightEventSourceMapping", "DeepEventSourceMapping")
UNCHANGED_INTEGRATION_API_LOGICAL_IDS = {
    "ReadingRequestIntegration": "ReadingHttpApi",
    "ReadingStatusIntegration": "ReadingHttpApi",
    "FincodeWebhookIntegration": "FincodeWebhookHttpApi",
}

FLAG_PARAMETERS = (
    "ReadingGenerateApiEnabled",
    "ReadingAsyncPaidEnabled",
    "ReadingStatusApiEnabled",
    "ReadingBedrockEnabled",
    "WorkerEventSourceMappingsEnabled",
    "FincodeWebhookEnabled",
    "FincodePeriodSourceEnabled",
    "FincodeProvisionalTestPeriodSourceEnabled",
    "FincodeOneTimeVoiceWebhookEnabled",
    "ReadingLightQuotaEnabled",
    "StagingLoginEnabled",
    "StagingSignupEnabled",
    "StagingMembershipStatusEnabled",
)

EXPECTED_ADDS = {
    "StagingAuthAttemptTable",
    "StagingLoginLogGroup",
    "StagingSignupLogGroup",
    "StagingMembershipStatusLogGroup",
    "StagingLoginRole",
    "StagingSignupRole",
    "StagingMembershipStatusRole",
    "StagingLoginFunction",
    "StagingSignupFunction",
    "StagingMembershipStatusFunction",
    "StagingLoginIntegration",
    "StagingSignupIntegration",
    "StagingMembershipStatusIntegration",
    "StagingLoginRoute",
    "StagingSignupRoute",
    "StagingMembershipStatusRoute",
    "StagingLoginInvokePermission",
    "StagingSignupInvokePermission",
    "StagingMembershipStatusInvokePermission",
}
EXPECTED_MODIFIES = {
    "ReadingHttpApi",
    "ReadingRequestFunction",
    "ReadingRequestIntegration",
    "ReadingStatusFunction",
    "ReadingStatusIntegration",
    "FincodeWebhookFunction",
    "FincodeWebhookIntegration",
    "FincodeWebhookRole",
}

DEDICATED_WEBHOOK_SECRET_NAME = "shirone7/staging/fincode/webhook-signature"


class DeployStopped(RuntimeError):
    pass


def safe(message: str) -> None:
    print(message, flush=True)


def tags(response: dict) -> dict[str, str]:
    return {item.get("Key", ""): item.get("Value", "") for item in response.get("Tags", [])}


def stack_parameters(stack: dict) -> dict[str, str]:
    return {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}


def require_staging_tags(client, secret_arn: str, expected_components: tuple[str, ...]) -> None:
    metadata = client.describe_secret(SecretId=secret_arn)
    actual = tags(metadata)
    if actual.get("Project") != PROJECT or actual.get("Environment") != ENVIRONMENT:
        raise DeployStopped("secret resource tags do not match staging")
    name = str(metadata.get("Name", "")).lower()
    if "prod" in name or "production" in name or not any(component in name for component in expected_components):
        raise DeployStopped("secret resource identity does not match staging")


def locate_runtime_secret(secrets) -> str:
    candidates: list[str] = []
    token = None
    while True:
        kwargs = {
            "Filters": [
                {"Key": "tag-value", "Values": [ENVIRONMENT]},
            ]
        }
        if token:
            kwargs["NextToken"] = token
        response = secrets.list_secrets(**kwargs)
        for item in response.get("SecretList", []):
            actual_tags = tags(item)
            name = str(item.get("Name", "")).lower()
            if (
                actual_tags.get("Project") == PROJECT
                and actual_tags.get("Environment") == ENVIRONMENT
                and any(component in name for component in ("runtime", "reading"))
                and not any(component in name for component in ("fincode", "webhook", "provider", "signature", "prod", "production"))
                and isinstance(item.get("ARN"), str)
            ):
                candidates.append(item["ARN"])
        token = response.get("NextToken")
        if not token:
            break
    if len(candidates) != 1:
        raise DeployStopped("staging Runtime Secret identity is ambiguous")
    return candidates[0]


def ensure_dedicated_webhook_secret(secrets, signature: str) -> tuple[str, str]:
    normalized = normalized_webhook_secret(signature)
    normalized_string = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    normalized_was_needed = False
    try:
        metadata = secrets.describe_secret(SecretId=DEDICATED_WEBHOOK_SECRET_NAME)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
        response = secrets.create_secret(
            Name=DEDICATED_WEBHOOK_SECRET_NAME,
            Description="Dedicated staging fincode Webhook signature",
            SecretString=normalized_string,
            Tags=[
                {"Key": "Project", "Value": PROJECT},
                {"Key": "Environment", "Value": ENVIRONMENT},
                {"Key": "Component", "Value": "fincode-webhook-signature"},
            ],
        )
        metadata = secrets.describe_secret(SecretId=response["ARN"])
    dedicated_arn = metadata.get("ARN", "")
    dedicated_tags = tags(metadata)
    if (
        metadata.get("Name") != DEDICATED_WEBHOOK_SECRET_NAME
        or dedicated_tags.get("Project") != PROJECT
        or dedicated_tags.get("Environment") != ENVIRONMENT
        or dedicated_tags.get("Component") != "fincode-webhook-signature"
    ):
        raise DeployStopped("dedicated webhook Secret metadata is invalid")
    current = secrets.get_secret_value(SecretId=dedicated_arn)
    if current.get("SecretBinary") is not None:
        raise DeployStopped("dedicated webhook Secret contract is invalid")
    current_string = current.get("SecretString", "")
    try:
        current_parsed: object = json.loads(current_string) if current_string.startswith("{") else current_string
        current_signature, current_format = extract_webhook_signature(current_parsed)
    except (json.JSONDecodeError, RuntimeSecretContractError):
        current_signature, current_format = "", "CONTRACT_MISMATCH"
    if current_signature != signature or current_format != "JSON_EXPECTED_KEY_PRESENT":
        normalized_was_needed = True
        secrets.put_secret_value(SecretId=dedicated_arn, SecretString=normalized_string)
        verify = secrets.get_secret_value(SecretId=dedicated_arn)
        verify_string = verify.get("SecretString", "")
        try:
            verify_parsed = json.loads(verify_string)
            verify_signature, verify_format = extract_webhook_signature(verify_parsed)
        except (json.JSONDecodeError, RuntimeSecretContractError) as error:
            raise DeployStopped("dedicated webhook Secret normalization failed") from error
        if verify_signature != signature or verify_format != "JSON_EXPECTED_KEY_PRESENT":
            raise DeployStopped("dedicated webhook Secret normalization failed")
        current_format = "JSON_EXPECTED_KEY_PRESENT"
    current = current_string = current_parsed = current_signature = normalized = normalized_string = None
    return dedicated_arn, "NORMALIZED" if normalized_was_needed else "PASS"


def resources_by_logical_id(cfn) -> dict[str, dict]:
    resources: dict[str, dict] = {}
    token = None
    while True:
        kwargs = {"StackName": STACK}
        if token:
            kwargs["NextToken"] = token
        response = cfn.list_stack_resources(**kwargs)
        for summary in response.get("StackResourceSummaries", []):
            resources[summary["LogicalResourceId"]] = summary
        token = response.get("NextToken")
        if not token:
            return resources


def exact_function_snapshot(lambda_client, function_name: str) -> dict:
    result = lambda_client.get_function(FunctionName=function_name)
    config = result["Configuration"]
    concurrency = lambda_client.get_function_concurrency(FunctionName=function_name)
    return {
        "CodeSha256": config.get("CodeSha256"),
        "Runtime": config.get("Runtime"),
        "Role": config.get("Role"),
        "Handler": config.get("Handler"),
        "Timeout": config.get("Timeout"),
        "MemorySize": config.get("MemorySize"),
        "Architectures": config.get("Architectures", []),
        "Environment": config.get("Environment", {}).get("Variables", {}),
        "ReservedConcurrentExecutions": concurrency.get("ReservedConcurrentExecutions"),
    }


def exact_integration_snapshot(apigw, api_id: str, integration_id: str) -> dict:
    response = apigw.get_integration(ApiId=api_id, IntegrationId=integration_id)
    return {
        key: response.get(key)
        for key in (
            "IntegrationType",
            "IntegrationMethod",
            "IntegrationUri",
            "PayloadFormatVersion",
            "TimeoutInMillis",
            "RequestParameters",
            "TlsConfig",
            "CredentialsArn",
            "Description",
        )
    }


def wait_change_set(cfn, name: str) -> dict:
    for _ in range(90):
        detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
        status = detail.get("Status")
        if status == "CREATE_COMPLETE":
            return detail
        if status == "FAILED":
            raise DeployStopped("change set creation failed")
        time.sleep(2)
    raise DeployStopped("change set creation timed out")


def wait_stack(cfn) -> dict:
    for _ in range(180):
        stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
        status = stack["StackStatus"]
        if status == "UPDATE_COMPLETE":
            return stack
        if "FAILED" in status or "ROLLBACK" in status:
            raise DeployStopped("stack update did not complete safely")
        time.sleep(5)
    raise DeployStopped("stack update timed out")


def review_change_set(detail: dict, expected_adds: set[str]) -> None:
    adds: set[str] = set()
    modifies: set[str] = set()
    for change in detail.get("Changes", []):
        resource = change.get("ResourceChange", {})
        action = resource.get("Action")
        logical_id = resource.get("LogicalResourceId", "")
        if action == "Add":
            adds.add(logical_id)
        elif action == "Modify":
            modifies.add(logical_id)
        else:
            raise DeployStopped("change set contains remove or unsupported action")
        replacement = resource.get("Replacement")
        if action == "Modify" and replacement not in (False, "False"):
            raise DeployStopped("change set contains replacement")
        if action == "Add" and replacement not in (None, False, "False"):
            raise DeployStopped("change set contains replacement")
    if adds != expected_adds or modifies != EXPECTED_MODIFIES:
        raise DeployStopped("change set resource scope differs from the approved set")


def inspect_template_safety(template: dict) -> None:
    serialized = json.dumps(template, ensure_ascii=True, separators=(",", ":")).lower()
    if "production" in serialized or "global." in serialized:
        raise DeployStopped("template contains a forbidden environment reference")
    for logical_id, resource in template.get("Resources", {}).items():
        if resource.get("Type") != "AWS::IAM::Role":
            continue
        for policy in resource.get("Properties", {}).get("Policies", []):
            for statement in policy.get("PolicyDocument", {}).get("Statement", []):
                actions = statement.get("Action", [])
                actions = actions if isinstance(actions, list) else [actions]
                resources = statement.get("Resource", [])
                resources = resources if isinstance(resources, list) else [resources]
                if any(action == "*" or str(action).endswith(":*") for action in actions):
                    raise DeployStopped(f"{logical_id} contains wildcard action")
                if "*" in resources:
                    raise DeployStopped(f"{logical_id} contains wildcard resource")


def call_json(url: str, method: str, body: bytes | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:4321"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            payload = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read()
    try:
        parsed = json.loads(payload.decode("utf-8")) if payload else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeployStopped("staging endpoint returned an invalid safe response") from error
    if not isinstance(parsed, dict):
        raise DeployStopped("staging endpoint response shape is invalid")
    return status, parsed


def safe_error_code(payload: dict) -> str:
    error = payload.get("error")
    return error.get("code", "") if isinstance(error, dict) else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        safe("STAGING_AUTH_UI_WIRING_DEPLOY_DRY_RUN_ONLY")
        return 0

    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    sts = session.client("sts")
    cfn = session.client("cloudformation")
    lambda_client = session.client("lambda")
    secrets = session.client("secretsmanager")
    s3 = session.client("s3")
    apigw = session.client("apigatewayv2")
    dynamodb = session.client("dynamodb")

    identity = sts.get_caller_identity()
    if identity.get("Account") != EXPECTED_ACCOUNT or ":root" in identity.get("Arn", ""):
        raise DeployStopped("AWS identity is not the approved staging boundary")

    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack.get("StackStatus") not in {"UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"}:
        raise DeployStopped("stack is not in an approved stable state")
    if f":{EXPECTED_ACCOUNT}:stack/{STACK}/" not in stack.get("StackId", ""):
        raise DeployStopped("stack identity is outside the approved boundary")
    resources = resources_by_logical_id(cfn)
    required = set(CONSUMER_LOGICAL_IDS) | set(EVENT_SOURCE_LOGICAL_IDS) | {
        "ReadingHttpApi", "FincodeWebhookHttpApi", "ReadingUsersTable", "FincodeWebhookFunction"
    }
    if not required.issubset(resources):
        raise DeployStopped("required staging resources are missing")

    runtime_arn = locate_runtime_secret(secrets)
    require_staging_tags(secrets, runtime_arn, ("runtime", "reading"))

    runtime_result = secrets.get_secret_value(SecretId=runtime_arn)
    try:
        runtime_json = json.loads(runtime_result.get("SecretString", ""))
    except json.JSONDecodeError as error:
        raise DeployStopped("runtime Secret JSON is invalid") from error
    if not isinstance(runtime_json, dict):
        raise DeployStopped("runtime Secret JSON contract is invalid")
    runtime_signature, _ = extract_webhook_signature(
        {"fincode_webhook_signature": runtime_json.get("fincode_webhook_signature")}
    )
    webhook_arn, webhook_format = ensure_dedicated_webhook_secret(secrets, runtime_signature)
    assert_secret_boundary(runtime_arn, webhook_arn, EXPECTED_ACCOUNT)
    require_staging_tags(secrets, webhook_arn, ("fincode",))
    safe("RUNTIME_SECRET_FOUND: true")
    safe("DEDICATED_WEBHOOK_SECRET_FOUND: true")
    safe("SECRETS_DISTINCT: true")
    safe(f"DEDICATED_WEBHOOK_SECRET_FORMAT: {webhook_format}")

    function_environments: dict[str, dict[str, str]] = {}
    for logical_id in CONSUMER_LOGICAL_IDS:
        physical_id = resources[logical_id].get("PhysicalResourceId", "")
        config = lambda_client.get_function_configuration(FunctionName=physical_id)
        function_environments[logical_id] = config.get("Environment", {}).get("Variables", {})
    canonical_values = resolve_canonical_values(function_environments)
    safe("CONSUMER_SECRET_VALUES_MATCH: true")

    existing_json = runtime_json
    merged = merge_runtime_secret(existing_json, canonical_values)
    if any(existing_json[key] != merged[key] for key in existing_json):
        raise DeployStopped("runtime Secret merge would alter an existing key")
    runtime_merge_needed = any(existing_json.get(key) != canonical_values[key] for key in CANONICAL_KEYS)
    if runtime_merge_needed:
        secrets.put_secret_value(
            SecretId=runtime_arn,
            SecretString=json.dumps(merged, ensure_ascii=False, separators=(",", ":")),
        )
    verify_result = secrets.get_secret_value(SecretId=runtime_arn)
    try:
        verified_json = json.loads(verify_result.get("SecretString", ""))
    except json.JSONDecodeError as error:
        raise DeployStopped("updated runtime Secret JSON is invalid") from error
    if not canonical_keys_present(verified_json):
        raise DeployStopped("updated runtime Secret lacks the canonical contract")
    if any(verified_json.get(key) != canonical_values[key] for key in CANONICAL_KEYS):
        raise DeployStopped("updated runtime Secret does not match deployed consumers")
    if any(verified_json.get(key) != existing_json[key] for key in existing_json):
        raise DeployStopped("updated runtime Secret did not preserve existing JSON")
    runtime_result = runtime_json = runtime_signature = existing_json = merged = verify_result = verified_json = canonical_values = None
    safe("RUNTIME_SECRET_CANONICAL_KEYS_PRESENT: true")
    safe("RUNTIME_SECRET_EXISTING_KEYS_PRESERVED: true")
    safe(f"RUNTIME_SECRET_MERGE: {'PASS' if runtime_merge_needed else 'NOT_NEEDED'}")

    template_path = REPO / "infrastructure" / "reading-staging" / "template.json"
    template_bytes = template_path.read_bytes()
    template = json.loads(template_bytes.decode("utf-8"))
    inspect_template_safety(template)
    safe("DEPLOY_PREFLIGHT_TEMPLATE: PASS")
    if not PARAMETER_FILE.is_file():
        raise DeployStopped("approved change set parameter file is unavailable")
    change_parameters = json.loads(PARAMETER_FILE.read_text(encoding="utf-8"))
    by_key = {item["ParameterKey"]: item for item in change_parameters}
    if set(FLAG_PARAMETERS) - set(by_key):
        raise DeployStopped("kill switch parameters are incomplete")
    for name in FLAG_PARAMETERS:
        by_key[name] = {"ParameterKey": name, "ParameterValue": "false"}
    by_key["RuntimeSecretsArn"] = {"ParameterKey": "RuntimeSecretsArn", "ParameterValue": runtime_arn}
    by_key["FincodeWebhookSignatureSecretArn"] = {"ParameterKey": "FincodeWebhookSignatureSecretArn", "ParameterValue": webhook_arn}
    safe("DEPLOY_PREFLIGHT_PARAMETERS: PASS")

    parameters = stack_parameters(stack)
    bucket = parameters.get("ArtifactBucketName", "")
    if not bucket or "prod" in bucket.lower() or "production" in bucket.lower():
        raise DeployStopped("artifact bucket identity is outside staging")
    try:
        bucket_tags = {
            item["Key"]: item["Value"]
            for item in s3.get_bucket_tagging(
                Bucket=bucket,
                ExpectedBucketOwner=EXPECTED_ACCOUNT,
            ).get("TagSet", [])
        }
    except ClientError as error:
        # The existing artifact bucket is external to this stack and has no
        # tag contract in the canonical template.  A missing tag set is
        # therefore acceptable only while owner, region, stack parameter and
        # staging-only name checks continue to bind the resource.
        if error.response.get("Error", {}).get("Code") != "NoSuchTagSet":
            raise DeployStopped("artifact bucket tags are unavailable") from error
        bucket_tags = {}
    if bucket_tags and (
        bucket_tags.get("Project") != PROJECT
        or bucket_tags.get("Environment") != ENVIRONMENT
    ):
        raise DeployStopped("artifact bucket tags do not match staging")
    location = s3.get_bucket_location(
        Bucket=bucket,
        ExpectedBucketOwner=EXPECTED_ACCOUNT,
    ).get("LocationConstraint")
    if location != REGION:
        raise DeployStopped("artifact bucket region does not match staging")
    safe("DEPLOY_PREFLIGHT_ARTIFACT_BUCKET: PASS")

    for parameter_name, filename in (
        ("StagingLoginArtifactKey", "staging-login.zip"),
        ("StagingSignupArtifactKey", "staging-signup.zip"),
        ("StagingMembershipStatusArtifactKey", "staging-membership-status.zip"),
    ):
        item = by_key.get(parameter_name, {})
        key = item.get("ParameterValue", "")
        artifact = TEMP_DIR / filename
        if not artifact.is_file() or not key or "prod" in key.lower():
            raise DeployStopped("approved staging artifact is unavailable")
        s3.head_object(Bucket=bucket, Key=key, ExpectedBucketOwner=EXPECTED_ACCOUNT)
    safe("DEPLOY_PREFLIGHT_ARTIFACTS: PASS")

    template_digest = hashlib.sha256(template_bytes).hexdigest()
    template_key = f"reading-staging/auth-ui-wiring/{template_digest[:16]}/template.json"
    s3.put_object(
        Bucket=bucket,
        Key=template_key,
        Body=template_bytes,
        ContentType="application/json",
        ExpectedBucketOwner=EXPECTED_ACCOUNT,
    )
    safe("DEPLOY_TEMPLATE_UPLOADED: true")
    template_url = f"https://{bucket}.s3.{REGION}.amazonaws.com/{template_key}"

    worker_before = {
        logical_id: exact_function_snapshot(lambda_client, resources[logical_id]["PhysicalResourceId"])
        for logical_id in ("LightWorkerFunction", "DeepWorkerFunction")
    }
    integrations_before = {
        logical_id: exact_integration_snapshot(
            apigw,
            resources[api_logical_id]["PhysicalResourceId"],
            resources[logical_id]["PhysicalResourceId"],
        )
        for logical_id, api_logical_id in UNCHANGED_INTEGRATION_API_LOGICAL_IDS.items()
    }
    esm_before = {
        logical_id: lambda_client.get_event_source_mapping(UUID=resources[logical_id]["PhysicalResourceId"]).get("State")
        for logical_id in EVENT_SOURCE_LOGICAL_IDS
    }
    if set(esm_before.values()) != {"Disabled"}:
        raise DeployStopped("worker event source mapping is not disabled")
    safe("DEPLOY_PREFLIGHT_WORKERS: PASS")

    change_name = f"staging-auth-ui-wiring-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    cfn.create_change_set(
        StackName=STACK,
        ChangeSetName=change_name,
        ChangeSetType="UPDATE",
        Description="Staging auth and local UI wiring; all switches disabled",
        TemplateURL=template_url,
        Parameters=list(by_key.values()),
        Capabilities=["CAPABILITY_IAM"],
    )
    safe("CHANGE_SET_CREATED: true")
    detail = wait_change_set(cfn, change_name)
    expected_adds = EXPECTED_ADDS - set(resources)
    review_change_set(detail, expected_adds)
    safe("CHANGE_SET_REMOVE: 0")
    safe("CHANGE_SET_REPLACEMENT: 0")
    safe("CHANGE_SET_PRODUCTION_REFERENCE: 0")
    safe("CHANGE_SET_SCOPE_APPROVED: true")

    update_started = datetime.now(timezone.utc)
    cfn.execute_change_set(StackName=STACK, ChangeSetName=change_name)
    stack = wait_stack(cfn)

    recent_events = cfn.describe_stack_events(StackName=STACK).get("StackEvents", [])
    bad_events = [
        event for event in recent_events
        if event.get("Timestamp", update_started) >= update_started
        and ("FAILED" in event.get("ResourceStatus", "") or "ROLLBACK" in event.get("ResourceStatus", ""))
    ]
    if bad_events:
        raise DeployStopped("stack update emitted a failure or rollback event")

    final_parameters = stack_parameters(stack)
    if any(final_parameters.get(name) != "false" for name in FLAG_PARAMETERS):
        raise DeployStopped("a deployed kill switch is not false")
    final_resources = resources_by_logical_id(cfn)
    for logical_id in EVENT_SOURCE_LOGICAL_IDS:
        state = lambda_client.get_event_source_mapping(UUID=final_resources[logical_id]["PhysicalResourceId"]).get("State")
        if state != "Disabled":
            raise DeployStopped("worker event source mapping changed state")

    for logical_id, before in worker_before.items():
        after = exact_function_snapshot(lambda_client, final_resources[logical_id]["PhysicalResourceId"])
        if after != before:
            raise DeployStopped("worker effective configuration changed")

    api_id = final_resources["ReadingHttpApi"]["PhysicalResourceId"]
    for logical_id, before in integrations_before.items():
        api_logical_id = UNCHANGED_INTEGRATION_API_LOGICAL_IDS[logical_id]
        after = exact_integration_snapshot(
            apigw,
            final_resources[api_logical_id]["PhysicalResourceId"],
            final_resources[logical_id]["PhysicalResourceId"],
        )
        if after != before:
            raise DeployStopped("an existing integration effective configuration changed")

    deployed_webhook_env = lambda_client.get_function_configuration(
        FunctionName=final_resources["FincodeWebhookFunction"]["PhysicalResourceId"]
    ).get("Environment", {}).get("Variables", {})
    if deployed_webhook_env.get("FINCODE_WEBHOOK_SIGNATURE_SECRET_ID") != webhook_arn or webhook_arn == runtime_arn:
        raise DeployStopped("deployed webhook Secret reference is not separated")

    for logical_id, flag in (
        ("StagingLoginFunction", "STAGING_LOGIN_ENABLED"),
        ("StagingSignupFunction", "STAGING_SIGNUP_ENABLED"),
        ("StagingMembershipStatusFunction", "STAGING_MEMBERSHIP_STATUS_ENABLED"),
    ):
        env = lambda_client.get_function_configuration(
            FunctionName=final_resources[logical_id]["PhysicalResourceId"]
        ).get("Environment", {}).get("Variables", {})
        if env.get(flag) != "false" or "SESSION_TOKEN_SECRET" in env:
            raise DeployStopped("deployed auth runtime is not fail closed")

    api = apigw.get_api(ApiId=api_id)
    endpoint = api.get("ApiEndpoint", "")
    if not endpoint.startswith("https://") or "prod" in endpoint.lower():
        raise DeployStopped("staging API endpoint boundary is invalid")
    routes = {item.get("RouteKey", "") for item in apigw.get_routes(ApiId=api_id).get("Items", [])}
    if not AUTH_ROUTES.issubset(routes):
        raise DeployStopped("staging auth routes are missing")

    users_table = final_resources["ReadingUsersTable"]["PhysicalResourceId"]
    before_item_count = dynamodb.describe_table(TableName=users_table)["Table"].get("ItemCount")
    base = endpoint.rstrip("/") + "/staging"
    checks = (
        ("POST", "/login", b"{}", "STAGING_LOGIN_DISABLED"),
        ("POST", "/signup", b"{}", "STAGING_SIGNUP_DISABLED"),
        ("GET", "/membership/status", None, "STAGING_MEMBERSHIP_STATUS_DISABLED"),
        ("POST", "/reading", b"{}", "READING_API_DISABLED"),
    )
    for method, path, body, code in checks:
        status, payload = call_json(base + path, method, body)
        if status != 503 or safe_error_code(payload) != code or "token" in json.dumps(payload).lower():
            raise DeployStopped("disabled staging endpoint did not fail closed")
    after_item_count = dynamodb.describe_table(TableName=users_table)["Table"].get("ItemCount")
    if before_item_count != after_item_count:
        raise DeployStopped("users table metadata changed during disabled smoke tests")

    safe("STACK_STATUS: UPDATE_COMPLETE")
    safe("AUTH_KILL_SWITCHES_FALSE: true")
    safe("FINCODE_FLAGS_FALSE: true")
    safe("BEDROCK_FALSE: true")
    safe("WORKER_ESM_DISABLED: true")
    safe("AUTH_ROUTES_PRESENT: true")
    safe("DISABLED_REQUESTS_FAIL_CLOSED: true")
    safe("USERS_MUTATION: 0")
    safe("ACCOUNT_CREATION: 0")
    safe("SESSION_ISSUANCE: 0")
    safe("FINCODE_TEST_PAYMENT: 0")
    safe("PRODUCTION_ACCESS_OR_MUTATION: 0")
    safe("STAGING_AUTH_UI_WIRING_READY")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DeployStopped, RuntimeSecretContractError, ClientError) as error:
        safe(f"STAGING_AUTH_UI_WIRING_STOPPED: {type(error).__name__}")
        raise SystemExit(1)
