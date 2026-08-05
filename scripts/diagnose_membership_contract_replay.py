"""Read-only diagnosis for the last staging membership replay."""

from __future__ import annotations

import json
import re
import time

import boto3

from preflight_membership_contract_safe_resume import (
    EXPECTED_ACCOUNT,
    PROFILE,
    REGION,
    STACK,
    TARGET_USER,
    av_bool,
    av_int,
    av_text,
    digest,
    stable_reference,
)


def main() -> None:
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    if session.client("sts").get_caller_identity().get("Account") != EXPECTED_ACCOUNT:
        raise RuntimeError("STAGING_ACCOUNT_BOUNDARY_REJECTED")
    cfn = session.client("cloudformation")
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    params = {entry["ParameterKey"]: entry.get("ParameterValue") for entry in stack.get("Parameters", [])}
    resources = {
        entry["LogicalResourceId"]: entry["PhysicalResourceId"]
        for entry in cfn.describe_stack_resources(StackName=STACK)["StackResources"]
    }
    lambda_client = session.client("lambda")
    env = lambda_client.get_function_configuration(
        FunctionName=resources["FincodeWebhookFunction"]
    ).get("Environment", {}).get("Variables", {})
    cfn_flags_false = all(params.get(key) == "false" for key in (
        "FincodeWebhookEnabled", "FincodePeriodSourceEnabled",
        "FincodeProvisionalTestPeriodSourceEnabled", "FincodeOneTimeVoiceWebhookEnabled",
    ))
    lambda_flags_false = all(env.get(key) == "false" for key in (
        "FINCODE_WEBHOOK_ENABLED", "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED", "FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED",
    ))

    audit = None
    logs = session.client("logs")
    group = resources["FincodeWebhookLogGroup"]
    response = logs.filter_log_events(
        logGroupName=group,
        startTime=int((time.time() - 3600) * 1000),
        filterPattern='"WEBHOOK_CONFLICT"',
        limit=50,
    )
    for event in reversed(response.get("events", [])):
        message = event.get("message", "")
        start = message.find("{")
        if start < 0:
            continue
        try:
            record = json.loads(message[start:])
        except Exception:
            continue
        if isinstance(record, dict) and record.get("result_code") == "WEBHOOK_CONFLICT":
            audit = {
                key: record.get(key)
                for key in (
                    "verification_outcome", "response_classification", "replay_outcome",
                    "transition_decision", "result_code",
                )
            }
            break

    dynamo = session.client("dynamodb")
    user = dynamo.get_item(
        TableName=resources["ReadingUsersTable"],
        Key={"user_id": {"S": TARGET_USER}},
        ConsistentRead=True,
    ).get("Item", {})
    period_types = {
        key: "NULL" if user.get(key, {}).get("NULL") is True else "S" if isinstance(user.get(key, {}).get("S"), str) else "ABSENT"
        for key in ("current_period_start", "current_period_end")
    }
    expected_user_conditions = {
        "schema": av_text(user, "membership_schema_version") == "shirone-membership-v1",
        "version": isinstance(av_int(user, "membership_version"), int),
        "plan_free": av_text(user, "plan") == "free",
        "status_inactive": av_text(user, "subscription_status") == "inactive",
        "deep_false": av_bool(user, "deep_enabled") is False,
        "voice_limit_zero": av_int(user, "monthly_voice_limit") == 0,
        "voice_used_zero": av_int(user, "monthly_voice_used") == 0,
        "extra_voice_zero": av_int(user, "extra_voice_remaining") == 0,
        "cancel_false": av_bool(user, "cancel_at_period_end") is False,
        "source_allowed": av_text(user, "membership_source") in ("fincode_direct", "manual", "legacy_migration"),
        "period_pair_legacy_null_or_absent": period_types["current_period_start"] == period_types["current_period_end"] and period_types["current_period_start"] in ("NULL", "ABSENT"),
    }
    updated_at = av_text(user, "membership_updated_at") or ""
    timestamp_match = re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(Z|\+00:00)", updated_at)
    updated_at_shape = (
        f"UTC_{'Z' if timestamp_match.group(2) == 'Z' else 'PLUS_00'}_FRACTION_{len(timestamp_match.group(1) or '')}"
        if timestamp_match else "UNSUPPORTED"
    )
    customer_ref = stable_reference("stg_customer_ui_", TARGET_USER)
    mapping = dynamo.get_item(
        TableName=resources["FincodeCustomerMappingTable"],
        Key={"customer_ref_digest": {"S": digest(customer_ref)}},
        ConsistentRead=True,
    ).get("Item", {})
    mapping_conditions = {
        "owner": av_text(mapping, "internal_user_id") == TARGET_USER,
        "environment": av_text(mapping, "environment") == "staging",
        "active": av_text(mapping, "mapping_status") == "ACTIVE",
        "version": isinstance(av_int(mapping, "version"), int) and av_int(mapping, "version") >= 1,
    }
    print(json.dumps({
        "cloudformation_flags_false": cfn_flags_false,
        "lambda_flags_false": lambda_flags_false,
        "audit": audit,
        "user_condition_checks": expected_user_conditions,
        "period_attribute_types": period_types,
        "membership_updated_at_shape": updated_at_shape,
        "mapping_condition_checks": mapping_conditions,
        "production_accesses": 0,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
