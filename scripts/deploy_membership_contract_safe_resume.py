"""Create/review/execute the staging-only membership contract Change Set."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
EXPECTED_ACCOUNT = "946385207519"
STACK = "nana-reading-staging"
REPO = Path(__file__).resolve().parents[1]
TEMPLATE = REPO / "infrastructure" / "reading-staging" / "template.json"
ARTIFACTS = {
    "StagingSignupArtifactKey": REPO / "dist" / "staging-signup-membership-contract-20260804-v2.zip",
    "FincodeWebhookArtifactKey": REPO / "dist" / "fincode-webhook-membership-contract-20260804-v2.zip",
}
FALSE_PARAMETERS = (
    "ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled",
    "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled", "FincodeWebhookEnabled",
    "FincodePeriodSourceEnabled", "FincodeProvisionalTestPeriodSourceEnabled",
    "FincodeOneTimeVoiceWebhookEnabled", "ReadingLightQuotaEnabled", "StagingLoginEnabled",
    "StagingSignupEnabled", "StagingMembershipStatusEnabled",
)
ALLOWED_CHANGES = {
    "StagingSignupFunction": "AWS::Lambda::Function",
    "StagingSignupIntegration": "AWS::ApiGatewayV2::Integration",
    "FincodeWebhookFunction": "AWS::Lambda::Function",
    "FincodeWebhookIntegration": "AWS::ApiGatewayV2::Integration",
}


class DeployStopped(RuntimeError):
    pass


def stop(code: str) -> None:
    raise DeployStopped(code)


def clients():
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    identity = session.client("sts").get_caller_identity()
    if identity.get("Account") != EXPECTED_ACCOUNT or ":assumed-role/AWSReservedSSO_AdministratorAccess_" not in str(identity.get("Arn")):
        stop("STAGING_ACCOUNT_BOUNDARY_REJECTED")
    return session, session.client("cloudformation"), session.client("lambda"), session.client("s3")


def stack_state(cfn):
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack.get("StackStatus") != "UPDATE_COMPLETE" or EXPECTED_ACCOUNT not in stack.get("StackId", ""):
        stop("STAGING_STACK_BOUNDARY_REJECTED")
    parameters = {entry["ParameterKey"]: entry.get("ParameterValue") for entry in stack.get("Parameters", [])}
    if parameters.get("Environment") != "staging" or any(parameters.get(key) != "false" for key in FALSE_PARAMETERS):
        stop("STAGING_FLAGS_NOT_FALSE")
    resources = {
        entry["LogicalResourceId"]: entry["PhysicalResourceId"]
        for entry in cfn.describe_stack_resources(StackName=STACK)["StackResources"]
    }
    required = ("StagingSignupFunction", "FincodeWebhookFunction", "LightEventSourceMapping", "DeepEventSourceMapping")
    if any(key not in resources for key in required):
        stop("STAGING_RESOURCE_BOUNDARY_REJECTED")
    return stack, parameters, resources


def verify_runtime_false(lambda_client, resources):
    signup = lambda_client.get_function_configuration(FunctionName=resources["StagingSignupFunction"])
    if signup.get("Environment", {}).get("Variables", {}).get("STAGING_SIGNUP_ENABLED") != "false":
        stop("SIGNUP_FLAG_NOT_FALSE")
    webhook = lambda_client.get_function_configuration(FunctionName=resources["FincodeWebhookFunction"])
    env = webhook.get("Environment", {}).get("Variables", {})
    keys = (
        "FINCODE_WEBHOOK_ENABLED", "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED", "FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED",
    )
    if any(env.get(key) != "false" for key in keys):
        stop("FINCODE_FLAGS_NOT_FALSE")
    for logical in ("LightEventSourceMapping", "DeepEventSourceMapping"):
        if lambda_client.get_event_source_mapping(UUID=resources[logical]).get("State") != "Disabled":
            stop("WORKER_ESM_NOT_DISABLED")


def file_contract(path: Path) -> tuple[bytes, str]:
    if not path.is_file():
        stop("ARTIFACT_MISSING")
    body = path.read_bytes()
    if not body or len(body) > 50 * 1024 * 1024:
        stop("ARTIFACT_REJECTED")
    return body, hashlib.sha256(body).hexdigest()


def wait_change_set(cfn, name: str):
    for _ in range(90):
        detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
        if detail.get("Status") == "CREATE_COMPLETE":
            return detail
        if detail.get("Status") == "FAILED":
            stop("CHANGE_SET_CREATE_FAILED")
        time.sleep(2)
    stop("CHANGE_SET_CREATE_TIMEOUT")


def review(detail: dict) -> list[dict]:
    safe_changes = []
    for entry in detail.get("Changes", []):
        if entry.get("Type") != "Resource":
            stop("CHANGE_SET_NON_RESOURCE_CHANGE")
        change = entry.get("ResourceChange", {})
        logical = change.get("LogicalResourceId")
        resource_type = change.get("ResourceType")
        action = change.get("Action")
        replacement = change.get("Replacement")
        if action != "Modify" or replacement not in (False, "False") or ALLOWED_CHANGES.get(logical) != resource_type:
            stop("CHANGE_SET_SCOPE_REJECTED")
        safe_changes.append({"logical_id": logical, "action": action, "replacement": False})
    if not safe_changes or not {"StagingSignupFunction", "FincodeWebhookFunction"}.issubset({c["logical_id"] for c in safe_changes}):
        stop("CHANGE_SET_EXPECTED_FUNCTIONS_MISSING")
    return safe_changes


def create() -> None:
    _, cfn, lambda_client, s3 = clients()
    stack, parameters, resources = stack_state(cfn)
    verify_runtime_false(lambda_client, resources)
    bucket = parameters.get("ArtifactBucketName")
    if not isinstance(bucket, str) or not bucket or "prod" in bucket.lower() or "production" in bucket.lower():
        stop("ARTIFACT_BUCKET_REJECTED")
    location = s3.get_bucket_location(Bucket=bucket, ExpectedBucketOwner=EXPECTED_ACCOUNT).get("LocationConstraint")
    if location != REGION:
        stop("ARTIFACT_BUCKET_REJECTED")
    overrides = {}
    for parameter, path in ARTIFACTS.items():
        body, sha = file_contract(path)
        key = f"membership-contract-safe-resume/20260804/{parameter.lower()}-{sha[:16]}.zip"
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/zip",
            ServerSideEncryption="AES256",
            Metadata={"sha256": sha, "environment": "staging"},
            ExpectedBucketOwner=EXPECTED_ACCOUNT,
        )
        head = s3.head_object(Bucket=bucket, Key=key, ExpectedBucketOwner=EXPECTED_ACCOUNT)
        if head.get("ContentLength") != len(body) or head.get("Metadata", {}).get("sha256") != sha:
            stop("ARTIFACT_UPLOAD_VERIFICATION_FAILED")
        overrides[parameter] = key

    parameter_list = []
    for entry in stack.get("Parameters", []):
        key = entry["ParameterKey"]
        parameter_list.append(
            {"ParameterKey": key, "ParameterValue": overrides[key]}
            if key in overrides else {"ParameterKey": key, "UsePreviousValue": True}
        )
    name = f"membership-contract-safe-resume-{int(time.time())}"
    template_bytes = TEMPLATE.read_bytes()
    template_body = template_bytes.decode("utf-8")
    if re_search_production(template_body):
        stop("PRODUCTION_REFERENCE_REJECTED")
    template_sha = hashlib.sha256(template_bytes).hexdigest()
    template_key = f"membership-contract-safe-resume/20260804/template-{template_sha[:16]}.json"
    s3.put_object(
        Bucket=bucket,
        Key=template_key,
        Body=template_bytes,
        ContentType="application/json",
        ServerSideEncryption="AES256",
        Metadata={"sha256": template_sha, "environment": "staging"},
        ExpectedBucketOwner=EXPECTED_ACCOUNT,
    )
    template_head = s3.head_object(Bucket=bucket, Key=template_key, ExpectedBucketOwner=EXPECTED_ACCOUNT)
    if template_head.get("ContentLength") != len(template_bytes) or template_head.get("Metadata", {}).get("sha256") != template_sha:
        stop("TEMPLATE_UPLOAD_VERIFICATION_FAILED")
    template_url = f"https://{bucket}.s3.{REGION}.amazonaws.com/{template_key}"
    try:
        cfn.create_change_set(
            StackName=STACK,
            ChangeSetName=name,
            ChangeSetType="UPDATE",
            TemplateURL=template_url,
            Parameters=parameter_list,
            Capabilities=["CAPABILITY_NAMED_IAM"],
            Description="staging-only membership contract compatibility and safe ledger resume",
        )
    except ClientError as error:
        raise DeployStopped("CHANGE_SET_CREATE_REQUEST_REJECTED") from error
    detail = wait_change_set(cfn, name)
    safe_changes = review(detail)
    print(json.dumps({
        "change_set": name,
        "status": "AVAILABLE",
        "remove": 0,
        "replacement": 0,
        "production_references": 0,
        "changes": safe_changes,
        "flags_false": True,
        "worker_esm_disabled": True,
    }, separators=(",", ":")))


def re_search_production(text: str) -> bool:
    lowered = text.lower()
    return "arn:aws" in lowered and (":prod" in lowered or "/prod" in lowered or "production" in lowered)


def execute(name: str) -> None:
    _, cfn, lambda_client, _ = clients()
    _, _, resources = stack_state(cfn)
    verify_runtime_false(lambda_client, resources)
    detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
    if detail.get("Status") != "CREATE_COMPLETE" or detail.get("ExecutionStatus") != "AVAILABLE":
        stop("CHANGE_SET_NOT_AVAILABLE")
    safe_changes = review(detail)
    cfn.execute_change_set(StackName=STACK, ChangeSetName=name)
    for _ in range(180):
        stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
        status = stack.get("StackStatus")
        if status == "UPDATE_COMPLETE":
            break
        if not isinstance(status, str) or "ROLLBACK" in status or "FAILED" in status:
            stop("STACK_UPDATE_FAILED")
        time.sleep(3)
    else:
        stop("STACK_UPDATE_TIMEOUT")
    _, _, resources = stack_state(cfn)
    verify_runtime_false(lambda_client, resources)
    print(json.dumps({
        "stack": "UPDATE_COMPLETE",
        "changes": safe_changes,
        "flags_false": True,
        "worker_esm_disabled": True,
        "production_accesses": 0,
    }, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("create")
    execute_parser = sub.add_parser("execute")
    execute_parser.add_argument("--change-set", required=True)
    args = parser.parse_args()
    if args.command == "create":
        create()
    else:
        execute(args.change_set)


if __name__ == "__main__":
    try:
        main()
    except DeployStopped as error:
        print(json.dumps({"deployment": "BLOCKED", "safe_code": str(error), "production_accesses": 0}, separators=(",", ":")))
        raise SystemExit(2)
