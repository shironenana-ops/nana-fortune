"""Enable staging Webhook briefly, replay one exact reservation, and restore."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from botocore.exceptions import ClientError

from preflight_membership_contract_safe_resume import (
    EXPECTED_ACCOUNT,
    STACK,
    TARGET_USER,
    PreflightStopped,
    av_bool,
    av_int,
    av_text,
    collect_context,
)


class ReplayStopped(RuntimeError):
    pass


def stop(code: str) -> None:
    raise ReplayStopped(code)


FINCODE_PARAMETERS = (
    "FincodeWebhookEnabled",
    "FincodePeriodSourceEnabled",
    "FincodeProvisionalTestPeriodSourceEnabled",
)
FALSE_PARAMETERS = (
    "ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled",
    "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled", "FincodeOneTimeVoiceWebhookEnabled",
    "ReadingLightQuotaEnabled", "StagingLoginEnabled", "StagingSignupEnabled", "StagingMembershipStatusEnabled",
)


def wait_stack(cfn) -> None:
    for _ in range(180):
        stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
        status = stack.get("StackStatus")
        if status == "UPDATE_COMPLETE":
            return
        if not isinstance(status, str) or "ROLLBACK" in status or "FAILED" in status:
            stop("STACK_UPDATE_FAILED")
        time.sleep(3)
    stop("STACK_UPDATE_TIMEOUT")


def wait_change_set(cfn, name: str):
    for _ in range(90):
        detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
        if detail.get("Status") == "CREATE_COMPLETE":
            return detail
        if detail.get("Status") == "FAILED":
            reason = detail.get("StatusReason", "")
            if "didn't contain changes" in reason:
                return None
            stop("FLAG_CHANGE_SET_FAILED")
        time.sleep(2)
    stop("FLAG_CHANGE_SET_TIMEOUT")


def verify_flag_state(context: dict, enabled: bool) -> None:
    cfn = context["cfn"]
    lambda_client = context["lambda_client"]
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack.get("StackStatus") != "UPDATE_COMPLETE" or EXPECTED_ACCOUNT not in stack.get("StackId", ""):
        stop("STAGING_STACK_BOUNDARY_REJECTED")
    params = {entry["ParameterKey"]: entry.get("ParameterValue") for entry in stack.get("Parameters", [])}
    expected = "true" if enabled else "false"
    if any(params.get(key) != expected for key in FINCODE_PARAMETERS):
        stop("CLOUDFORMATION_FLAG_STATE_MISMATCH")
    if any(params.get(key) != "false" for key in FALSE_PARAMETERS):
        stop("CLOUDFORMATION_SAFETY_FLAG_CHANGED")
    env = lambda_client.get_function_configuration(
        FunctionName=context["resources"]["FincodeWebhookFunction"]
    ).get("Environment", {}).get("Variables", {})
    runtime_keys = (
        "FINCODE_WEBHOOK_ENABLED", "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED",
    )
    if any(env.get(key) != expected for key in runtime_keys):
        stop("LAMBDA_FLAG_STATE_MISMATCH")
    if env.get("FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED") != "false":
        stop("VOICE_WEBHOOK_FLAG_CHANGED")
    for logical in ("LightEventSourceMapping", "DeepEventSourceMapping"):
        if lambda_client.get_event_source_mapping(UUID=context["resources"][logical]).get("State") != "Disabled":
            stop("WORKER_ESM_NOT_DISABLED")


def change_flags(context: dict, enabled: bool) -> None:
    cfn = context["cfn"]
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    parameters = []
    expected = "true" if enabled else "false"
    overrides = {key: expected for key in FINCODE_PARAMETERS}
    overrides.update({key: "false" for key in FALSE_PARAMETERS})
    for entry in stack.get("Parameters", []):
        key = entry["ParameterKey"]
        parameters.append(
            {"ParameterKey": key, "ParameterValue": overrides[key]}
            if key in overrides else {"ParameterKey": key, "UsePreviousValue": True}
        )
    name = f"membership-safe-resume-{'enable' if enabled else 'disable'}-{int(time.time())}"
    try:
        cfn.create_change_set(
            StackName=STACK,
            ChangeSetName=name,
            ChangeSetType="UPDATE",
            UsePreviousTemplate=True,
            Parameters=parameters,
            Capabilities=["CAPABILITY_NAMED_IAM"],
            Description="temporary staging-only exact Webhook replay flags",
        )
    except ClientError as error:
        raise ReplayStopped("FLAG_CHANGE_SET_REQUEST_REJECTED") from error
    detail = wait_change_set(cfn, name)
    if detail is not None:
        allowed = {
            "FincodeWebhookFunction": "AWS::Lambda::Function",
            "FincodeWebhookIntegration": "AWS::ApiGatewayV2::Integration",
        }
        changes = detail.get("Changes", [])
        if not changes:
            stop("FLAG_CHANGE_SET_EMPTY")
        for entry in changes:
            change = entry.get("ResourceChange", {})
            if (
                entry.get("Type") != "Resource"
                or change.get("Action") != "Modify"
                or change.get("Replacement") not in (False, "False")
                or allowed.get(change.get("LogicalResourceId")) != change.get("ResourceType")
            ):
                stop("FLAG_CHANGE_SET_SCOPE_REJECTED")
        cfn.execute_change_set(StackName=STACK, ChangeSetName=name)
        wait_stack(cfn)
    verify_flag_state(context, enabled)


def post_once(context: dict) -> int:
    apigw = context["session"].client("apigatewayv2")
    api = apigw.get_api(ApiId=context["resources"]["FincodeWebhookHttpApi"])
    endpoint = api.get("ApiEndpoint")
    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or ".execute-api.ap-northeast-1.amazonaws.com" not in endpoint:
        stop("STAGING_WEBHOOK_ENDPOINT_REJECTED")
    url = endpoint.rstrip("/") + "/staging/webhooks/fincode"
    body = json.dumps(context["payload"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, method="POST", data=body, headers={
        "content-type": "application/json",
        "fincode-signature": context["signature"],
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(4097)
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read(4097)
        status = error.code
    except (urllib.error.URLError, TimeoutError) as error:
        raise ReplayStopped("STAGING_WEBHOOK_REQUEST_UNAVAILABLE") from error
    if len(raw) > 4096:
        stop("STAGING_WEBHOOK_RESPONSE_REJECTED")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        parsed = None
    if status != 200 or parsed != {"receive": "0"}:
        stop(f"STAGING_WEBHOOK_SAFE_HTTP_{status}")
    return status


def verify_completion(context: dict) -> dict:
    dynamo = context["dynamo"]
    resources = context["resources"]
    user = dynamo.get_item(
        TableName=resources["ReadingUsersTable"],
        Key={"user_id": {"S": TARGET_USER}},
        ConsistentRead=True,
    ).get("Item", {})
    expected_version = context["membership_version"] + 1
    membership_ok = (
        av_text(user, "plan") == "light"
        and av_text(user, "subscription_status") == "active"
        and av_bool(user, "deep_enabled") is False
        and av_int(user, "monthly_voice_limit") == 3
        and av_int(user, "monthly_voice_used") == 0
        and av_int(user, "extra_voice_remaining") == 0
        and av_int(user, "membership_version") == expected_version
        and av_text(user, "current_period_start") == context["period_start"]
        and av_text(user, "current_period_end") == context["period_end"]
        and av_text(user, "last_membership_event_digest") == context["semantic_key"]
        and isinstance(av_text(user, "membership_updated_at"), str)
        and av_text(user, "membership_updated_at").endswith("Z")
    )
    if not membership_ok:
        stop("MEMBERSHIP_COMPLETION_NOT_VERIFIED")
    quota = dynamo.get_item(
        TableName=resources["FincodeLightQuotaTable"],
        Key={"quota_ref": {"S": context["quota_ref"]}},
        ConsistentRead=True,
    ).get("Item", {})
    quota_ok = (
        av_text(quota, "period_id") == context["period_id"]
        and av_text(quota, "period_start") == context["period_start"]
        and av_text(quota, "period_end") == context["period_end"]
        and av_text(quota, "plan") == "light"
        and av_int(quota, "limit") == 5
        and av_int(quota, "used") == 0
        and av_int(quota, "membership_version") == expected_version
    )
    if not quota_ok:
        stop("LIGHT_QUOTA_COMPLETION_NOT_VERIFIED")
    ledger = dynamo.get_item(
        TableName=resources["FincodeWebhookLedgerTable"],
        Key={"event_digest": {"S": context["semantic_key"]}},
        ConsistentRead=True,
    ).get("Item", {})
    ledger_ok = (
        av_text(ledger, "payload_fingerprint") == context["payload_fingerprint"]
        and av_text(ledger, "processing_state") == "COMPLETED"
        and av_text(ledger, "result_code") == "ENTITLEMENT_APPLIED"
        and isinstance(av_text(ledger, "completed_at"), str)
    )
    if not ledger_ok:
        stop("LEDGER_COMPLETION_NOT_VERIFIED")
    return {
        "membership": "LIGHT",
        "light_quota": 5,
        "voice_quota": 3,
        "deep_quota": 0,
        "ledger": "COMPLETED",
    }


def main() -> None:
    context = collect_context(True)
    changed = False
    result = None
    primary_error = None
    try:
        change_flags(context, True)
        changed = True
        post_once(context)
        result = verify_completion(context)
    except Exception as error:
        primary_error = error
    finally:
        try:
            change_flags(context, False)
            verify_flag_state(context, False)
        except Exception as restore_error:
            context["signature"] = None
            raise ReplayStopped("SAFETY_RESTORE_FAILED") from restore_error
        context["signature"] = None
    if primary_error is not None:
        if isinstance(primary_error, (ReplayStopped, PreflightStopped)):
            raise primary_error
        raise ReplayStopped("REPLAY_INTERNAL_ERROR") from primary_error
    if not changed or result is None:
        stop("REPLAY_RESULT_UNAVAILABLE")
    print(json.dumps({
        "existing_webhook_replay": "PASS",
        **result,
        "cloudformation_flags_restored_false": True,
        "lambda_flags_restored_false": True,
        "worker_esm_disabled": True,
        "production_accesses": 0,
        "new_payment": 0,
        "new_subscription": 0,
        "secrets_exposed": 0,
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ReplayStopped, PreflightStopped) as error:
        print(json.dumps({
            "replay": "BLOCKED",
            "safe_code": str(error),
            "safety_restore_attempted": True,
            "production_accesses": 0,
            "new_payment": 0,
            "new_subscription": 0,
            "secrets_exposed": 0,
        }, separators=(",", ":")))
        raise SystemExit(2)
