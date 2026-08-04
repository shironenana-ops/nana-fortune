"""Temporarily toggle staging membership UI routes with a fail-closed scope."""

from __future__ import annotations

import argparse
import json
import time

import boto3

from preflight_membership_contract_safe_resume import EXPECTED_ACCOUNT, PROFILE, REGION, STACK


SAFETY_FLAGS = (
    "ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled",
    "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled", "FincodeWebhookEnabled",
    "FincodePeriodSourceEnabled", "FincodeProvisionalTestPeriodSourceEnabled",
    "FincodeOneTimeVoiceWebhookEnabled", "ReadingLightQuotaEnabled", "StagingLoginEnabled",
    "StagingSignupEnabled", "StagingMembershipStatusEnabled",
)

LAMBDA_FLAGS = {
    "StagingLoginFunction": "STAGING_LOGIN_ENABLED",
    "StagingSignupFunction": "STAGING_SIGNUP_ENABLED",
    "StagingMembershipStatusFunction": "STAGING_MEMBERSHIP_STATUS_ENABLED",
}

RUNTIME_FALSE_FLAGS = {
    "ReadingRequestFunction": (
        "READING_GENERATE_API_ENABLED",
        "READING_ASYNC_PAID_ENABLED",
        "READING_LIGHT_QUOTA_ENABLED",
    ),
    "ReadingStatusFunction": ("READING_STATUS_API_ENABLED",),
    "LightWorkerFunction": ("READING_BEDROCK_ENABLED",),
    "DeepWorkerFunction": ("READING_BEDROCK_ENABLED",),
    "FincodeWebhookFunction": (
        "FINCODE_WEBHOOK_ENABLED",
        "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED",
        "FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED",
    ),
}


def stop(code: str) -> None:
    raise RuntimeError(code)


def wait_stack(cfn) -> None:
    for _ in range(180):
        status = cfn.describe_stacks(StackName=STACK)["Stacks"][0].get("StackStatus")
        if status == "UPDATE_COMPLETE":
            return
        if not isinstance(status, str) or "ROLLBACK" in status or "FAILED" in status:
            stop("STACK_UPDATE_FAILED")
        time.sleep(3)
    stop("STACK_UPDATE_TIMEOUT")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "state",
        choices=("enable", "disable", "enable-final-light-ui", "disable-final-light-ui"),
    )
    args = parser.parse_args()
    membership_enabled = args.state in ("enable", "enable-final-light-ui")
    login_enabled = args.state == "enable-final-light-ui"
    targets = {
        "StagingLoginEnabled": "true" if login_enabled else "false",
        "StagingSignupEnabled": "false",
        "StagingMembershipStatusEnabled": "true" if membership_enabled else "false",
    }
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    if session.client("sts").get_caller_identity().get("Account") != EXPECTED_ACCOUNT:
        stop("STAGING_ACCOUNT_BOUNDARY_REJECTED")
    cfn = session.client("cloudformation")
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack.get("StackStatus") != "UPDATE_COMPLETE" or EXPECTED_ACCOUNT not in stack.get("StackId", ""):
        stop("STAGING_STACK_BOUNDARY_REJECTED")
    current = {entry["ParameterKey"]: entry.get("ParameterValue") for entry in stack.get("Parameters", [])}
    if args.state.startswith("enable") and any(current.get(key) != "false" for key in SAFETY_FLAGS):
        stop("OTHER_SAFETY_FLAG_NOT_FALSE")
    if any(current.get(key) != "false" for key in SAFETY_FLAGS if key not in targets):
        stop("OTHER_SAFETY_FLAG_NOT_FALSE")
    changed = {key for key, value in targets.items() if current.get(key) != value}
    if changed:
        parameters = []
        for entry in stack.get("Parameters", []):
            key = entry["ParameterKey"]
            parameters.append(
                {"ParameterKey": key, "ParameterValue": targets[key]}
                if key in targets
                else {"ParameterKey": key, "UsePreviousValue": True}
            )
        name = f"membership-ui-{args.state}-{int(time.time())}"
        cfn.create_change_set(
            StackName=STACK,
            ChangeSetName=name,
            ChangeSetType="UPDATE",
            UsePreviousTemplate=True,
            Parameters=parameters,
            Capabilities=["CAPABILITY_NAMED_IAM"],
            Description="temporary staging membership UI verification",
        )
        for _ in range(90):
            detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
            if detail.get("Status") == "CREATE_COMPLETE":
                break
            if detail.get("Status") == "FAILED":
                stop("CHANGE_SET_CREATE_FAILED")
            time.sleep(2)
        else:
            stop("CHANGE_SET_TIMEOUT")
        allowed = {}
        if "StagingLoginEnabled" in changed:
            allowed.update({
                "StagingLoginFunction": "AWS::Lambda::Function",
                "StagingLoginIntegration": "AWS::ApiGatewayV2::Integration",
            })
        if "StagingMembershipStatusEnabled" in changed:
            allowed.update({
                "StagingMembershipStatusFunction": "AWS::Lambda::Function",
                "StagingMembershipStatusIntegration": "AWS::ApiGatewayV2::Integration",
            })
        changes = detail.get("Changes", [])
        if not changes:
            stop("CHANGE_SET_EMPTY")
        for entry in changes:
            change = entry.get("ResourceChange", {})
            if (
                entry.get("Type") != "Resource"
                or change.get("Action") != "Modify"
                or change.get("Replacement") not in (False, "False")
                or allowed.get(change.get("LogicalResourceId")) != change.get("ResourceType")
            ):
                stop("CHANGE_SET_SCOPE_REJECTED")
        cfn.execute_change_set(StackName=STACK, ChangeSetName=name)
        wait_stack(cfn)

    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    final = {entry["ParameterKey"]: entry.get("ParameterValue") for entry in stack.get("Parameters", [])}
    if any(final.get(key) != value for key, value in targets.items()):
        stop("CLOUDFORMATION_FLAG_VERIFY_FAILED")
    if any(final.get(key) != "false" for key in SAFETY_FLAGS if key not in targets):
        stop("CLOUDFORMATION_FLAG_VERIFY_FAILED")
    resources = {
        entry["LogicalResourceId"]: entry["PhysicalResourceId"]
        for entry in cfn.describe_stack_resources(StackName=STACK)["StackResources"]
    }
    lambda_client = session.client("lambda")
    expected_runtime = {
        "STAGING_LOGIN_ENABLED": targets["StagingLoginEnabled"],
        "STAGING_SIGNUP_ENABLED": "false",
        "STAGING_MEMBERSHIP_STATUS_ENABLED": targets["StagingMembershipStatusEnabled"],
    }
    for logical, flag in LAMBDA_FLAGS.items():
        env = lambda_client.get_function_configuration(
            FunctionName=resources[logical]
        ).get("Environment", {}).get("Variables", {})
        if env.get(flag) != expected_runtime[flag]:
            stop("LAMBDA_FLAG_VERIFY_FAILED")
    for logical, flags in RUNTIME_FALSE_FLAGS.items():
        env = lambda_client.get_function_configuration(
            FunctionName=resources[logical]
        ).get("Environment", {}).get("Variables", {})
        if any(env.get(flag) != "false" for flag in flags):
            stop("LAMBDA_SAFETY_FLAG_NOT_FALSE")
    for logical in ("LightEventSourceMapping", "DeepEventSourceMapping"):
        if lambda_client.get_event_source_mapping(UUID=resources[logical]).get("State") != "Disabled":
            stop("WORKER_ESM_NOT_DISABLED")
    print(json.dumps({
        "staging_login_enabled": login_enabled,
        "staging_signup_enabled": False,
        "staging_membership_status_enabled": membership_enabled,
        "all_other_flags_false": True,
        "worker_esm_disabled": True,
        "production_accesses": 0,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
