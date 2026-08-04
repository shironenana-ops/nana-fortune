"""Import three retained staging auth log groups without replacing them."""

from __future__ import annotations

import copy
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
EXPECTED_ACCOUNT = "946385207519"
STACK = "nana-reading-staging"
REPO = Path(__file__).resolve().parents[1]

LOG_GROUPS = {
    "StagingLoginLogGroup": f"/aws/lambda/{STACK}-staging-login",
    "StagingSignupLogGroup": f"/aws/lambda/{STACK}-staging-signup",
    "StagingMembershipStatusLogGroup": f"/aws/lambda/{STACK}-staging-membership-status",
}


class ImportStopped(RuntimeError):
    pass


def safe(message: str) -> None:
    print(message, flush=True)


def wait_change_set(cfn, name: str) -> dict:
    for _ in range(90):
        detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
        if detail.get("Status") == "CREATE_COMPLETE":
            return detail
        if detail.get("Status") == "FAILED":
            raise ImportStopped("import change set creation failed")
        time.sleep(2)
    raise ImportStopped("import change set creation timed out")


def wait_import(cfn) -> dict:
    for _ in range(180):
        stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
        status = stack.get("StackStatus", "")
        if status == "IMPORT_COMPLETE":
            return stack
        if "FAILED" in status or "ROLLBACK" in status:
            raise ImportStopped("stack import failed")
        time.sleep(5)
    raise ImportStopped("stack import timed out")


def expected_resource(local_template: dict, logical_id: str) -> dict:
    resource = local_template.get("Resources", {}).get(logical_id)
    if not isinstance(resource, dict):
        raise ImportStopped("local import resource is missing")
    if resource.get("Type") != "AWS::Logs::LogGroup":
        raise ImportStopped("local import resource type is invalid")
    if resource.get("DeletionPolicy") != "Retain" or resource.get("UpdateReplacePolicy") != "Retain":
        raise ImportStopped("local import resource retention policy is unsafe")
    properties = resource.get("Properties")
    if not isinstance(properties, dict) or set(properties) != {"LogGroupName", "RetentionInDays"}:
        raise ImportStopped("local import resource has unexpected properties")
    if properties.get("RetentionInDays") != 30:
        raise ImportStopped("local import retention differs from the approved value")
    expected_name = {"Fn::Sub": f"/aws/lambda/${{AWS::StackName}}-{LOG_GROUPS[logical_id].split('-staging-', 1)[1]}"}
    if properties.get("LogGroupName") != expected_name:
        raise ImportStopped("local import log group name differs from the approved value")
    return copy.deepcopy(resource)


def verify_actual(logs, logical_id: str, name: str, stack_id: str) -> None:
    response = logs.describe_log_groups(logGroupNamePrefix=name)
    matches = [item for item in response.get("logGroups", []) if item.get("logGroupName") == name]
    if len(matches) != 1:
        raise ImportStopped("retained log group identity is ambiguous")
    actual = matches[0]
    if actual.get("retentionInDays") != 30 or actual.get("storedBytes", 0) != 0:
        raise ImportStopped("retained log group metadata differs from the approved state")
    if actual.get("kmsKeyId"):
        raise ImportStopped("retained log group unexpectedly uses KMS")
    if actual.get("logGroupClass", "STANDARD") != "STANDARD":
        raise ImportStopped("retained log group class differs from the template default")
    safe(f"{logical_id}_CORE_METADATA: PASS")
    # describe_log_groups exposes an IAM-pattern ARN with a trailing ``:*``
    # as ``arn``.  The tagging API requires the resource ARN without it.
    tag_arn = actual.get("logGroupArn") or str(actual["arn"]).removesuffix(":*")
    tag_response = logs.list_tags_for_resource(resourceArn=tag_arn)
    actual_tags = tag_response.get("tags", {})
    expected_tags = {
        "aws:cloudformation:stack-name": STACK,
        "aws:cloudformation:stack-id": stack_id,
        "aws:cloudformation:logical-id": logical_id,
    }
    if actual_tags != expected_tags:
        raise ImportStopped("retained log group ownership tags do not match the current stack")
    safe(f"{logical_id}_TAGS: PASS")
    streams = logs.describe_log_streams(logGroupName=name, limit=1).get("logStreams", [])
    if streams:
        raise ImportStopped("retained log group contains a log stream")
    safe(f"{logical_id}_STREAMS: PASS")
    safe(f"{logical_id}_RETAINED_FROM_CURRENT_STACK: true")
    safe(f"{logical_id}_METADATA_MATCH: true")


def main() -> int:
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    sts = session.client("sts")
    cfn = session.client("cloudformation")
    logs = session.client("logs")

    identity = sts.get_caller_identity()
    if identity.get("Account") != EXPECTED_ACCOUNT or ":root" in identity.get("Arn", ""):
        raise ImportStopped("AWS identity is outside the approved staging boundary")
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack.get("StackStatus") != "UPDATE_COMPLETE":
        raise ImportStopped("stack is not ready for a resource import")
    if f":{EXPECTED_ACCOUNT}:stack/{STACK}/" not in stack.get("StackId", ""):
        raise ImportStopped("stack identity is outside the approved staging boundary")

    local_template = json.loads(
        (REPO / "infrastructure" / "reading-staging" / "template.json").read_text(encoding="utf-8")
    )
    import_resources: dict[str, dict] = {}
    for logical_id, name in LOG_GROUPS.items():
        import_resources[logical_id] = expected_resource(local_template, logical_id)
        verify_actual(logs, logical_id, name, stack["StackId"])

    current = cfn.get_template(StackName=STACK, TemplateStage="Original")["TemplateBody"]
    if not isinstance(current, dict):
        raise ImportStopped("deployed template shape is invalid")
    if set(LOG_GROUPS) & set(current.get("Resources", {})):
        raise ImportStopped("an import target is already in the stack template")
    import_template = copy.deepcopy(current)
    import_template.setdefault("Resources", {}).update(import_resources)
    body = json.dumps(import_template, ensure_ascii=True, separators=(",", ":"))
    if len(body.encode("utf-8")) > 51_200:
        raise ImportStopped("import template exceeds the safe inline size")

    change_name = f"staging-auth-log-group-import-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    parameters = [
        {"ParameterKey": item["ParameterKey"], "UsePreviousValue": True}
        for item in stack.get("Parameters", [])
    ]
    resources_to_import = [
        {
            "ResourceType": "AWS::Logs::LogGroup",
            "LogicalResourceId": logical_id,
            "ResourceIdentifier": {"LogGroupName": name},
        }
        for logical_id, name in LOG_GROUPS.items()
    ]
    cfn.create_change_set(
        StackName=STACK,
        ChangeSetName=change_name,
        ChangeSetType="IMPORT",
        Description="Import three retained staging auth log groups",
        TemplateBody=body,
        Parameters=parameters,
        ResourcesToImport=resources_to_import,
        Capabilities=["CAPABILITY_IAM"],
    )
    safe("IMPORT_CHANGE_SET_CREATED: true")
    detail = wait_change_set(cfn, change_name)
    changes = [item.get("ResourceChange", {}) for item in detail.get("Changes", [])]
    if len(changes) != 3:
        raise ImportStopped("import change set contains an unexpected resource count")
    if {item.get("LogicalResourceId") for item in changes} != set(LOG_GROUPS):
        raise ImportStopped("import change set contains an unexpected logical resource")
    if any(item.get("Action") != "Import" for item in changes):
        raise ImportStopped("import change set contains a non-import action")
    if any(item.get("Replacement") not in (None, False, "False") for item in changes):
        raise ImportStopped("import change set contains replacement")
    safe("IMPORT_CHANGE_SET_SCOPE: 3_IMPORT_ONLY")
    safe("IMPORT_CREATE_MODIFY_DELETE_REPLACEMENT: 0")

    cfn.execute_change_set(StackName=STACK, ChangeSetName=change_name)
    wait_import(cfn)
    managed = {
        item.get("LogicalResourceId"): item.get("PhysicalResourceId")
        for item in cfn.describe_stack_resources(StackName=STACK).get("StackResources", [])
    }
    if any(managed.get(logical_id) != name for logical_id, name in LOG_GROUPS.items()):
        raise ImportStopped("an imported log group is not managed by the staging stack")

    for logical_id in LOG_GROUPS:
        drift = cfn.detect_stack_resource_drift(
            StackName=STACK,
            LogicalResourceId=logical_id,
        ).get("StackResourceDrift", {})
        if drift.get("StackResourceDriftStatus") != "IN_SYNC":
            raise ImportStopped("an imported log group is not in sync")
        safe(f"{logical_id}_DRIFT: IN_SYNC")
    safe("STACK_STATUS: IMPORT_COMPLETE")
    safe("STAGING_AUTH_LOG_GROUP_IMPORT_READY")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ImportStopped, ClientError) as error:
        safe(f"STAGING_AUTH_LOG_GROUP_IMPORT_STOPPED: {type(error).__name__}")
        raise SystemExit(1)
