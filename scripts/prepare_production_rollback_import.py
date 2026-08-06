"""Inventory retained Release B resources and prepare a non-destructive import.

This tool is read-only against AWS. It never reads DynamoDB items or CloudWatch
log events; DynamoDB is accessed with Select=COUNT only.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import boto3


EXPECTED_ACCOUNT = "388811589005"
EXPECTED_REGION = "ap-northeast-1"
STACK_NAME = "nana-reading-production"

TABLE_IDS = (
    "ReadingIdempotencyTable",
    "ReadingRateLimitTable",
    "ReadingDeepQuotaTable",
    "ReadingJobsTable",
    "FincodeLightQuotaTable",
)
LOG_IDS = (
    "ReadingRequestLogGroup",
    "ReadingStatusLogGroup",
    "LightWorkerLogGroup",
    "DeepWorkerLogGroup",
    "MembershipStatusLogGroup",
)
EXPECTED_IDS = TABLE_IDS + LOG_IDS


class RecoveryBlocked(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def resolve(value: Any, parameters: dict[str, str]) -> Any:
    if isinstance(value, list):
        return [resolve(item, parameters) for item in value]
    if isinstance(value, dict):
        if set(value) == {"Ref"} and value["Ref"] in parameters:
            return parameters[value["Ref"]]
        return {key: resolve(child, parameters) for key, child in value.items()}
    return value


def tag_map(tags: list[dict[str, str]]) -> dict[str, str]:
    return {str(tag["Key"]): str(tag["Value"]) for tag in tags}


def assert_subset(expected: dict[str, str], actual: dict[str, str], code: str) -> None:
    for key, value in expected.items():
        if actual.get(key) != value:
            raise RecoveryBlocked(f"{code}:{key}")


def count_table(dynamodb: Any, table_name: str) -> int:
    total = 0
    start_key = None
    while True:
        request: dict[str, Any] = {"TableName": table_name, "Select": "COUNT", "ConsistentRead": True}
        if start_key:
            request["ExclusiveStartKey"] = start_key
        response = dynamodb.scan(**request)
        total += int(response.get("Count", 0))
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--parameters", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    template_path = Path(args.template).resolve()
    parameters_path = Path(args.parameters).resolve()
    output_dir = Path(args.output_dir).resolve()
    template = json.loads(template_path.read_text(encoding="utf-8"))
    parameter_list = json.loads(parameters_path.read_text(encoding="utf-8"))
    parameters = {entry["ParameterKey"]: entry["ParameterValue"] for entry in parameter_list}
    if parameters.get("Environment") != "production":
        raise RecoveryBlocked("PARAMETER_ENVIRONMENT_INVALID")

    session = boto3.Session(profile_name=args.profile, region_name=EXPECTED_REGION)
    sts = session.client("sts")
    identity = sts.get_caller_identity()
    if identity.get("Account") != EXPECTED_ACCOUNT:
        raise RecoveryBlocked("CALLER_ACCOUNT_MISMATCH")

    cfn = session.client("cloudformation")
    dynamodb = session.client("dynamodb")
    logs = session.client("logs")

    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    if stack.get("StackStatus") != "ROLLBACK_COMPLETE":
        raise RecoveryBlocked("STACK_NOT_ROLLBACK_COMPLETE")
    stack_id = str(stack["StackId"])
    if f":{EXPECTED_ACCOUNT}:stack/{STACK_NAME}/" not in stack_id:
        raise RecoveryBlocked("STACK_ID_BOUNDARY_MISMATCH")

    stack_resources = cfn.describe_stack_resources(StackName=STACK_NAME)["StackResources"]
    retained = [resource for resource in stack_resources if resource.get("ResourceStatus") == "DELETE_SKIPPED"]
    retained_by_id = {str(resource["LogicalResourceId"]): resource for resource in retained}
    if len(retained) != 10 or set(retained_by_id) != set(EXPECTED_IDS):
        raise RecoveryBlocked("RETAINED_RESOURCE_SET_MISMATCH")
    if any(resource["LogicalResourceId"] in {"ReadingUsersTable", "ReadingHistoryTable"} for resource in retained):
        raise RecoveryBlocked("LEGACY_RESOURCE_INCLUDED")

    inventory: list[dict[str, Any]] = []
    resources_to_import: list[dict[str, Any]] = []
    import_resources: dict[str, Any] = {}

    for logical_id in TABLE_IDS:
        stack_resource = retained_by_id[logical_id]
        if stack_resource.get("ResourceType") != "AWS::DynamoDB::Table":
            raise RecoveryBlocked(f"RESOURCE_TYPE_MISMATCH:{logical_id}")
        table_name = str(stack_resource["PhysicalResourceId"])
        if table_name in {"shirone7_users", "shirone7_history"} or not table_name.startswith(f"{STACK_NAME}-"):
            raise RecoveryBlocked(f"TABLE_BOUNDARY_MISMATCH:{logical_id}")
        live = dynamodb.describe_table(TableName=table_name)["Table"]
        arn = str(live["TableArn"])
        if f":{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:table/" not in arn:
            raise RecoveryBlocked(f"TABLE_ARN_BOUNDARY_MISMATCH:{logical_id}")
        item_count = count_table(dynamodb, table_name)
        if item_count != 0:
            raise RecoveryBlocked(f"TABLE_NOT_EMPTY:{logical_id}")
        ttl = dynamodb.describe_time_to_live(TableName=table_name)["TimeToLiveDescription"]
        backups = dynamodb.describe_continuous_backups(TableName=table_name)["ContinuousBackupsDescription"]
        live_tags = tag_map(dynamodb.list_tags_of_resource(ResourceArn=arn).get("Tags", []))
        expected_resource = template["Resources"][logical_id]
        properties = resolve(expected_resource["Properties"], parameters)
        expected_tags = tag_map(properties.get("Tags", []))
        assert_subset(expected_tags, live_tags, f"TABLE_TAG_MISMATCH:{logical_id}")
        if live_tags.get("Environment") != "production" or any("staging" in value.lower() for value in live_tags.values()):
            raise RecoveryBlocked(f"TABLE_ENVIRONMENT_MISMATCH:{logical_id}")
        if live.get("TableStatus") != "ACTIVE":
            raise RecoveryBlocked(f"TABLE_NOT_ACTIVE:{logical_id}")
        if canonical(live.get("KeySchema", [])) != canonical(properties.get("KeySchema", [])):
            raise RecoveryBlocked(f"TABLE_KEY_SCHEMA_MISMATCH:{logical_id}")
        if canonical(live.get("AttributeDefinitions", [])) != canonical(properties.get("AttributeDefinitions", [])):
            raise RecoveryBlocked(f"TABLE_ATTRIBUTE_DEFINITIONS_MISMATCH:{logical_id}")
        if live.get("BillingModeSummary", {}).get("BillingMode") != properties.get("BillingMode"):
            raise RecoveryBlocked(f"TABLE_BILLING_MODE_MISMATCH:{logical_id}")
        if live.get("GlobalSecondaryIndexes") or live.get("LocalSecondaryIndexes"):
            raise RecoveryBlocked(f"TABLE_INDEX_MISMATCH:{logical_id}")
        expected_ttl = properties.get("TimeToLiveSpecification", {})
        if ttl.get("TimeToLiveStatus") != "ENABLED" or ttl.get("AttributeName") != expected_ttl.get("AttributeName"):
            raise RecoveryBlocked(f"TABLE_TTL_MISMATCH:{logical_id}")
        if live.get("LatestStreamArn") or live.get("StreamSpecification", {}).get("StreamEnabled"):
            raise RecoveryBlocked(f"TABLE_STREAM_MISMATCH:{logical_id}")
        if live.get("SSEDescription", {}).get("Status") != "ENABLED":
            raise RecoveryBlocked(f"TABLE_ENCRYPTION_MISMATCH:{logical_id}")
        pitr_expected = bool(properties.get("PointInTimeRecoverySpecification", {}).get("PointInTimeRecoveryEnabled"))
        pitr_status = backups.get("PointInTimeRecoveryDescription", {}).get("PointInTimeRecoveryStatus")
        if (pitr_status == "ENABLED") != pitr_expected:
            raise RecoveryBlocked(f"TABLE_PITR_MISMATCH:{logical_id}")
        if bool(live.get("DeletionProtectionEnabled")) != bool(properties.get("DeletionProtectionEnabled")):
            raise RecoveryBlocked(f"TABLE_DELETION_PROTECTION_MISMATCH:{logical_id}")
        if expected_resource.get("DeletionPolicy") != "Retain" or expected_resource.get("UpdateReplacePolicy") != "Retain":
            raise RecoveryBlocked(f"TABLE_RETAIN_POLICY_MISSING:{logical_id}")

        inventory.append({
            "logical_resource_id": logical_id,
            "resource_type": "AWS::DynamoDB::Table",
            "physical_resource_id": table_name,
            "resource_status": "DELETE_SKIPPED",
            "account": EXPECTED_ACCOUNT,
            "region": EXPECTED_REGION,
            "import_identifier_property": "TableName",
            "item_count": item_count,
            "properties_match": True,
            "status": "ACTIVE",
            "billing_mode": live["BillingModeSummary"]["BillingMode"],
            "ttl": "ENABLED",
            "streams": "DISABLED",
            "encryption": "ENABLED",
            "pitr": pitr_status,
            "deletion_protection": bool(live.get("DeletionProtectionEnabled")),
            "tag_keys": sorted(live_tags),
            "cloudformation_stack_tag_present": "aws:cloudformation:stack-id" in live_tags,
        })
        resources_to_import.append({
            "ResourceType": "AWS::DynamoDB::Table",
            "LogicalResourceId": logical_id,
            "ResourceIdentifier": {"TableName": table_name},
        })
        import_resources[logical_id] = expected_resource

    for logical_id in LOG_IDS:
        stack_resource = retained_by_id[logical_id]
        if stack_resource.get("ResourceType") != "AWS::Logs::LogGroup":
            raise RecoveryBlocked(f"RESOURCE_TYPE_MISMATCH:{logical_id}")
        log_group_name = str(stack_resource["PhysicalResourceId"])
        expected_resource = template["Resources"][logical_id]
        expected_name = f"/aws/lambda/{STACK_NAME}-" + {
            "ReadingRequestLogGroup": "reading-request",
            "ReadingStatusLogGroup": "reading-status",
            "LightWorkerLogGroup": "reading-light-worker",
            "DeepWorkerLogGroup": "reading-deep-worker",
            "MembershipStatusLogGroup": "membership-status",
        }[logical_id]
        if log_group_name != expected_name:
            raise RecoveryBlocked(f"LOG_GROUP_NAME_MISMATCH:{logical_id}")
        matches = [entry for entry in logs.describe_log_groups(logGroupNamePrefix=log_group_name).get("logGroups", []) if entry.get("logGroupName") == log_group_name]
        if len(matches) != 1:
            raise RecoveryBlocked(f"LOG_GROUP_NOT_UNIQUE:{logical_id}")
        live = matches[0]
        arn = str(live["arn"])
        if f":{EXPECTED_REGION}:{EXPECTED_ACCOUNT}:log-group:" not in arn:
            raise RecoveryBlocked(f"LOG_GROUP_ARN_BOUNDARY_MISMATCH:{logical_id}")
        stream_count = 0
        paginator = logs.get_paginator("describe_log_streams")
        for page in paginator.paginate(LogGroupName=log_group_name):
            stream_count += len(page.get("logStreams", []))
            if stream_count:
                break
        if stream_count != 0:
            raise RecoveryBlocked(f"LOG_GROUP_NOT_EMPTY:{logical_id}")
        live_tags = logs.list_tags_for_resource(resourceArn=arn).get("tags", {})
        properties = expected_resource["Properties"]
        if live.get("retentionInDays") != properties.get("RetentionInDays"):
            raise RecoveryBlocked(f"LOG_RETENTION_MISMATCH:{logical_id}")
        if live.get("kmsKeyId") or properties.get("KmsKeyId"):
            raise RecoveryBlocked(f"LOG_KMS_MISMATCH:{logical_id}")
        if live.get("logGroupClass", "STANDARD") != properties.get("LogGroupClass", "STANDARD"):
            raise RecoveryBlocked(f"LOG_CLASS_MISMATCH:{logical_id}")
        if any("staging" in value.lower() for value in live_tags.values()):
            raise RecoveryBlocked(f"LOG_ENVIRONMENT_MISMATCH:{logical_id}")
        if expected_resource.get("DeletionPolicy") != "Retain" or expected_resource.get("UpdateReplacePolicy") != "Retain":
            raise RecoveryBlocked(f"LOG_RETAIN_POLICY_MISSING:{logical_id}")

        inventory.append({
            "logical_resource_id": logical_id,
            "resource_type": "AWS::Logs::LogGroup",
            "physical_resource_id": log_group_name,
            "resource_status": "DELETE_SKIPPED",
            "account": EXPECTED_ACCOUNT,
            "region": EXPECTED_REGION,
            "import_identifier_property": "LogGroupName",
            "stream_count": stream_count,
            "properties_match": True,
            "retention_days": live["retentionInDays"],
            "kms_configured": False,
            "log_group_class": live.get("logGroupClass", "STANDARD"),
            "tag_keys": sorted(live_tags),
            "cloudformation_stack_tag_present": "aws:cloudformation:stack-id" in live_tags,
        })
        resources_to_import.append({
            "ResourceType": "AWS::Logs::LogGroup",
            "LogicalResourceId": logical_id,
            "ResourceIdentifier": {"LogGroupName": log_group_name},
        })
        import_resources[logical_id] = expected_resource

    import_template = {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": "Import-only template for retained nana production Release B resources",
        "Parameters": {
            key: template["Parameters"][key]
            for key in ("Environment", "Owner", "CostCenter")
        },
        "Resources": import_resources,
    }
    serialized = canonical(import_template)
    if any(token in serialized.lower() for token in ("staging", "fincode/test", "payment:")):
        raise RecoveryBlocked("IMPORT_TEMPLATE_FORBIDDEN_TOKEN")
    if len(import_resources) != 10 or len(resources_to_import) != 10:
        raise RecoveryBlocked("IMPORT_RESOURCE_COUNT_MISMATCH")
    if len({entry["LogicalResourceId"] for entry in resources_to_import}) != 10:
        raise RecoveryBlocked("IMPORT_LOGICAL_ID_DUPLICATE")
    physical_ids = [next(iter(entry["ResourceIdentifier"].values())) for entry in resources_to_import]
    if len(set(physical_ids)) != 10:
        raise RecoveryBlocked("IMPORT_PHYSICAL_ID_DUPLICATE")

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "retained-inventory.json").write_text(json.dumps({
        "schema_version": "nana-release-b-retained-inventory-v1",
        "environment": "production",
        "account": EXPECTED_ACCOUNT,
        "region": EXPECTED_REGION,
        "source_stack_status": "ROLLBACK_COMPLETE",
        "source_stack_id": stack_id,
        "resource_count": len(inventory),
        "legacy_resources": 0,
        "all_dynamodb_item_counts_zero": True,
        "all_log_stream_counts_zero": True,
        "resources": inventory,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "import-only-template.json").write_text(json.dumps(import_template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "resources-to-import.json").write_text(json.dumps(resources_to_import, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Production Release B retained resource recovery inventory",
        "",
        "- Environment: production",
        f"- Account: {EXPECTED_ACCOUNT}",
        f"- Region: {EXPECTED_REGION}",
        "- Source stack: nana-reading-production / ROLLBACK_COMPLETE",
        "- Retained resources: 10",
        "- Legacy Users / History included: 0",
        "- DynamoDB item content read: 0 (Select=COUNT only)",
        "- CloudWatch log event content read: 0",
        "",
        "| LogicalResourceId | Type | PhysicalResourceId | Live status | Empty | Properties match | Import identifier |",
        "|---|---|---|---|---|---|---|",
    ]
    for entry in inventory:
        empty = entry.get("item_count", entry.get("stream_count")) == 0
        lines.append(f"| `{entry['logical_resource_id']}` | `{entry['resource_type']}` | `{entry['physical_resource_id']}` | `{entry.get('status', entry['resource_status'])}` | `{str(empty).lower()}` | `true` | `{entry['import_identifier_property']}` |")
    (output_dir / "RECOVERY_INVENTORY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps({
        "status": "PASS",
        "environment": "production",
        "retained_resources": 10,
        "dynamodb_tables": 5,
        "log_groups": 5,
        "dynamodb_items": 0,
        "log_streams": 0,
        "properties_match": 10,
        "legacy_resources": 0,
        "aws_mutations": 0,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RecoveryBlocked as error:
        print(json.dumps({"status": "BLOCKED", "code": str(error)}, separators=(",", ":")))
        raise SystemExit(2)
