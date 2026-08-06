"""Apply the explicitly approved five-user Release B migration.

This runner is intentionally production-specific and manifest-specific.  It
never infers identities, contract periods, plans, or quota values.  Dry-run is
the default; writes require --apply and use one conditional DynamoDB
transaction per user.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError


ACCOUNT = "388811589005"
REGION = "ap-northeast-1"
STACK = "nana-reading-production"
LEGACY_USERS = "shirone7_users"
LEGACY_HISTORY = "shirone7_history"
PERIOD_START = "2026-07-31T15:00:00.000Z"
PERIOD_END = "2026-08-31T15:00:00.000Z"
PERIOD_ID = hashlib.sha256(
    f"fincode-contract-period-v1\0{PERIOD_START}\0{PERIOD_END}".encode("utf-8")
).hexdigest()
SCHEMA_VERSION = "shirone-membership-v1"
MIGRATION_ID = "release-b-legacy-users-2026-08-06-v1"
OPERATOR_POLICY = Path(__file__).parents[1] / "ops" / "aws" / "production-release-b-bootstrap" / "operator-permission-set-policy.json"
LIGHT_SCHEMA = "fincode-membership-quota-v1"
DEEP_SCHEMA = "shirone-deep-quota-v1"
MASKED_YOKO = re.compile(r"^ara.+29@gmail\.com$", re.IGNORECASE)
EXPECTED_HISTORY = {
    "YOKO": 3,
    "test@test.com": 1,
    "test2@test.com": 20,
    "test3@test.com": 0,
    "test4@test.com": 4,
}
TARGETS = {
    "YOKO": {"plan": "premium", "status": "active", "light": 20, "deep": 3, "voice": 10, "classification": "INTERNAL_BETA_OR_MANUAL"},
    "test@test.com": {"plan": "premium", "status": "active", "light": 20, "deep": 3, "voice": 10, "classification": "INTERNAL_BETA_OR_MANUAL"},
    "test2@test.com": {"plan": "free", "status": "inactive", "light": 0, "deep": 0, "voice": 0, "classification": "FREE_WITH_LEGACY_VOICE"},
    "test3@test.com": {"plan": "light", "status": "active", "light": 5, "deep": 0, "voice": 3, "classification": "INTERNAL_BETA_OR_MANUAL"},
    "test4@test.com": {"plan": "premium", "status": "active", "light": 20, "deep": 3, "voice": 10, "classification": "INTERNAL_BETA_OR_MANUAL"},
}
LEGACY_FIELDS = (
    "plan", "subscription_status", "deep_enabled", "monthly_voice_limit",
    "monthly_voice_used", "monthly_voice_reserved", "extra_voice_remaining",
    "extra_voice_reserved", "cancel_at_period_end",
    "current_period_start", "current_period_end", "membership_schema_version",
    "membership_version", "membership_source", "membership_updated_at",
    "automatic_renewal", "grant_source", "created_at", "updated_at",
)
PROVIDER_FIELDS = (
    "fincode_customer_id", "fincode_subscription_id", "fincode_payment_id",
    "customer_id", "subscription_id", "payment_id", "purchase_id",
)
DESERIALIZER = TypeDeserializer()
SERIALIZER = TypeSerializer()


def _mask(value: str) -> str:
    local, domain = value.split("@", 1)
    return f"{local[:3]}***{local[-2:]}@{domain}"


def _logical_id(user_id: str) -> str | None:
    if MASKED_YOKO.fullmatch(user_id):
        return "YOKO"
    if user_id in TARGETS:
        return user_id
    return None


def _decode(item: dict[str, Any]) -> dict[str, Any]:
    return {key: DESERIALIZER.deserialize(value) for key, value in item.items()}


def _av(value: Any) -> dict[str, Any]:
    return SERIALIZER.serialize(value)


def _light_ref(user_id: str) -> str:
    return hashlib.sha256(
        f"shirone-light-quota-v1\0{user_id}\0{PERIOD_ID}".encode("utf-8")
    ).hexdigest()


def _deep_ref(user_id: str, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        f"{DEEP_SCHEMA}\0{user_id}\0{PERIOD_ID}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _canonical_target(target: dict[str, Any], migrated_at: str) -> dict[str, Any]:
    paid = target["plan"] != "free"
    return {
        "membership_schema_version": SCHEMA_VERSION,
        "membership_version": 1,
        "plan": target["plan"],
        "subscription_status": target["status"],
        "deep_enabled": target["plan"] == "premium",
        "monthly_voice_limit": target["voice"],
        "monthly_voice_used": 0,
        "monthly_voice_reserved": 0,
        "extra_voice_remaining": 0,
        "extra_voice_reserved": 0,
        "cancel_at_period_end": False,
        "automatic_renewal": False,
        "grant_source": "LEGACY_MANUAL_GRANT" if paid else "LEGACY_FREE_MIGRATION",
        "membership_source": "legacy_migration",
        "membership_updated_at": migrated_at,
        **({"current_period_start": PERIOD_START, "current_period_end": PERIOD_END} if paid else {}),
    }


def _matches_canonical(item: dict[str, Any], target: dict[str, Any]) -> bool:
    expected = _canonical_target(target, str(item.get("membership_updated_at", "")))
    if not item.get("membership_updated_at"):
        return False
    if target["plan"] == "free" and (
        item.get("current_period_start") is not None or item.get("current_period_end") is not None
    ):
        return False
    return all(item.get(key) == value for key, value in expected.items()) and (
        item.get("legacy_membership_migration_snapshot", {}).get("migration_id") == MIGRATION_ID
    )


def _canonical_mismatch_fields(item: dict[str, Any], target: dict[str, Any]) -> list[str]:
    expected = _canonical_target(target, str(item.get("membership_updated_at", "")))
    mismatches = [key for key, value in expected.items() if item.get(key) != value]
    if target["plan"] == "free" and item.get("current_period_start") is not None:
        mismatches.append("current_period_start")
    if target["plan"] == "free" and item.get("current_period_end") is not None:
        mismatches.append("current_period_end")
    if item.get("legacy_membership_migration_snapshot", {}).get("migration_id") != MIGRATION_ID:
        mismatches.append("legacy_membership_migration_snapshot")
    return sorted(set(mismatches))


def _stack_context(session: boto3.Session) -> dict[str, str]:
    caller = session.client("sts").get_caller_identity()
    if caller.get("Account") != ACCOUNT:
        raise RuntimeError("ACCOUNT_BOUNDARY_MISMATCH")
    cloudformation = session.client("cloudformation")
    stack = cloudformation.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack["StackStatus"] != "UPDATE_COMPLETE":
        raise RuntimeError("STACK_NOT_UPDATE_COMPLETE")
    resources = {
        entry["LogicalResourceId"]: entry["PhysicalResourceId"]
        for entry in cloudformation.describe_stack_resources(StackName=STACK)["StackResources"]
    }
    required = {"FincodeLightQuotaTable", "ReadingDeepQuotaTable"}
    if not required.issubset(resources):
        raise RuntimeError("MIGRATION_RESOURCE_CONTRACT_MISSING")
    if any("staging" in value.lower() for value in resources.values()):
        raise RuntimeError("STAGING_REFERENCE_DETECTED")
    return {
        "light_table": resources["FincodeLightQuotaTable"],
        "deep_table": resources["ReadingDeepQuotaTable"],
        "runtime_secret": _runtime_secret_arn_from_policy(),
    }


def _runtime_secret_arn_from_policy() -> str:
    try:
        policy = json.loads(OPERATOR_POLICY.read_text(encoding="utf-8"))
        statement = next(entry for entry in policy["Statement"] if entry.get("Sid") == "RuntimeSecretExactArnAfterCreation")
        resource = statement["Resource"]
    except (OSError, KeyError, StopIteration, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("RUNTIME_SECRET_POLICY_CONTRACT_INVALID") from error
    expected = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:shirone7/production/runtime-"
    if not isinstance(resource, str) or not resource.startswith(expected) or "staging" in resource.lower():
        raise RuntimeError("RUNTIME_SECRET_POLICY_BOUNDARY_MISMATCH")
    return resource


def _deep_secret(session: boto3.Session, secret_arn: str) -> str:
    payload = session.client("secretsmanager").get_secret_value(SecretId=secret_arn).get("SecretString")
    try:
        parsed = json.loads(payload or "")
    except json.JSONDecodeError as error:
        raise RuntimeError("RUNTIME_SECRET_JSON_INVALID") from error
    value = parsed.get("reading_deep_quota_hash_secret")
    if not isinstance(value, str) or len(value) < 32 or "\n" in value or "\r" in value or "\0" in value:
        raise RuntimeError("RUNTIME_SECRET_KEY_INVALID")
    return value


def _scan_users(dynamodb: Any) -> list[dict[str, Any]]:
    names = {f"#f{i}": name for i, name in enumerate(("user_id",) + LEGACY_FIELDS + PROVIDER_FIELDS + ("legacy_membership_migration_snapshot",))}
    response = dynamodb.scan(
        TableName=LEGACY_USERS,
        ProjectionExpression=", ".join(names),
        ExpressionAttributeNames=names,
        ConsistentRead=True,
    )
    if response.get("LastEvaluatedKey") or response.get("Count") != 5:
        raise RuntimeError("MIGRATION_SOURCE_COUNT_MISMATCH")
    return [_decode(item) for item in response.get("Items", [])]


def _history_count(dynamodb: Any, user_id: str) -> int:
    response = dynamodb.query(
        TableName=LEGACY_HISTORY,
        KeyConditionExpression="#owner = :owner",
        ExpressionAttributeNames={"#owner": "user_id"},
        ExpressionAttributeValues={":owner": {"S": user_id}},
        Select="COUNT",
        ConsistentRead=True,
    )
    return int(response.get("Count", -1))


def _get_item(dynamodb: Any, table: str, key: dict[str, Any]) -> dict[str, Any] | None:
    result = dynamodb.get_item(TableName=table, Key=key, ConsistentRead=True)
    return _decode(result["Item"]) if result.get("Item") else None


def _quota_matches(dynamodb: Any, context: dict[str, str], user_id: str, target: dict[str, Any], secret: str) -> bool:
    if target["plan"] == "free":
        return True
    light = _get_item(dynamodb, context["light_table"], {"quota_ref": {"S": _light_ref(user_id)}})
    if not light or any((
        light.get("schema_version") != LIGHT_SCHEMA,
        light.get("period_id") != PERIOD_ID,
        light.get("plan") != target["plan"],
        light.get("limit") != target["light"],
        light.get("used") != 0,
        light.get("membership_version") != 1,
    )):
        return False
    if target["plan"] != "premium":
        return True
    deep = _get_item(dynamodb, context["deep_table"], {"quota_ref": {"S": _deep_ref(user_id, secret)}})
    return bool(deep) and all((
        deep.get("schema_version") == DEEP_SCHEMA,
        deep.get("period_key") == PERIOD_ID,
        deep.get("limit") == 3,
        deep.get("used") == 0,
        deep.get("version") == 1,
    ))


def _diagnose_conflicts(dynamodb: Any, context: dict[str, str], entries: list[dict[str, Any]], secret: str) -> list[dict[str, Any]]:
    results = []
    for entry in entries:
        if entry["status"] != "CONFLICT":
            continue
        user_id, item, target = entry["user_id"], entry["item"], entry["target"]
        membership_fields = _canonical_mismatch_fields(item, target)
        light_ok = True
        deep_ok = True
        if target["plan"] != "free":
            light = _get_item(dynamodb, context["light_table"], {"quota_ref": {"S": _light_ref(user_id)}})
            light_ok = bool(light) and all((
                light.get("schema_version") == LIGHT_SCHEMA,
                light.get("period_id") == PERIOD_ID,
                light.get("plan") == target["plan"],
                light.get("limit") == target["light"],
                light.get("used") == 0,
                light.get("membership_version") == 1,
            ))
        if target["plan"] == "premium":
            deep = _get_item(dynamodb, context["deep_table"], {"quota_ref": {"S": _deep_ref(user_id, secret)}})
            deep_ok = bool(deep) and all((
                deep.get("schema_version") == DEEP_SCHEMA,
                deep.get("period_key") == PERIOD_ID,
                deep.get("limit") == 3,
                deep.get("used") == 0,
                deep.get("version") == 1,
            ))
        results.append({"user": _mask(user_id), "membership_mismatch_fields": membership_fields, "light_quota_match": light_ok, "deep_quota_match": deep_ok})
    return results


def _classify(dynamodb: Any, context: dict[str, str], items: list[dict[str, Any]], secret: str) -> list[dict[str, Any]]:
    resolved: dict[str, dict[str, Any]] = {}
    for item in items:
        user_id = str(item.get("user_id", ""))
        logical = _logical_id(user_id)
        if not logical or logical in resolved:
            raise RuntimeError("MIGRATION_TARGET_MANIFEST_MISMATCH")
        if any(item.get(field) not in (None, "") for field in PROVIDER_FIELDS):
            raise RuntimeError("PAYMENT_MAPPING_PRESENT")
        if _history_count(dynamodb, user_id) != EXPECTED_HISTORY[logical]:
            raise RuntimeError("HISTORY_COUNT_MISMATCH")
        target = TARGETS[logical]
        if item.get("membership_schema_version") == SCHEMA_VERSION:
            status = "NO_OP" if _matches_canonical(item, target) and _quota_matches(dynamodb, context, user_id, target, secret) else "CONFLICT"
        elif item.get("membership_schema_version") is None:
            status = "MIGRATABLE"
        else:
            status = "UNKNOWN"
        resolved[logical] = {"logical": logical, "user_id": user_id, "item": item, "target": target, "status": status}
    if set(resolved) != set(TARGETS):
        raise RuntimeError("MIGRATION_TARGET_MANIFEST_MISMATCH")
    return [resolved[key] for key in TARGETS]


def _legacy_condition(item: dict[str, Any]) -> tuple[str, dict[str, str], dict[str, Any]]:
    names: dict[str, str] = {"#owner": "user_id", "#schema": "membership_schema_version"}
    values: dict[str, Any] = {}
    expressions = ["attribute_exists(#owner)", "attribute_not_exists(#schema)"]
    for index, field in enumerate(LEGACY_FIELDS):
        if field in ("membership_schema_version",):
            continue
        name = f"#legacy{index}"
        names[name] = field
        if field in item:
            value = f":legacy{index}"
            values[value] = _av(item[field])
            expressions.append(f"{name} = {value}")
        else:
            expressions.append(f"attribute_not_exists({name})")
    return " AND ".join(expressions), names, values


def _transaction(context: dict[str, str], entry: dict[str, Any], deep_secret: str, migrated_at: str) -> list[dict[str, Any]]:
    user_id, item, target = entry["user_id"], entry["item"], entry["target"]
    condition, names, values = _legacy_condition(item)
    canonical = _canonical_target(target, migrated_at)
    snapshot_values = {field: item[field] for field in LEGACY_FIELDS if field in item}
    snapshot = {
        "migration_id": MIGRATION_ID,
        "classification": target["classification"],
        "captured_at": migrated_at,
        "history_count": EXPECTED_HISTORY[entry["logical"]],
        "present_fields": sorted(snapshot_values),
        "values": snapshot_values,
    }
    set_parts: list[str] = []
    for index, (field, value) in enumerate(canonical.items()):
        alias = f"#target{index}"
        placeholder = f":target{index}"
        names[alias] = field
        values[placeholder] = _av(value)
        set_parts.append(f"{alias} = {placeholder}")
    names["#snapshot"] = "legacy_membership_migration_snapshot"
    names["#updatedAt"] = "updated_at"
    values[":snapshot"] = _av(snapshot)
    values[":updatedAt"] = _av(migrated_at)
    set_parts.extend(["#snapshot = :snapshot", "#updatedAt = :updatedAt"])
    remove = ""
    if target["plan"] == "free":
        names["#periodStart"] = "current_period_start"
        names["#periodEnd"] = "current_period_end"
        remove = " REMOVE #periodStart, #periodEnd"
    actions: list[dict[str, Any]] = [{"Update": {
        "TableName": LEGACY_USERS,
        "Key": {"user_id": {"S": user_id}},
        "UpdateExpression": f"SET {', '.join(set_parts)}{remove}",
        "ConditionExpression": condition,
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }}]
    if target["plan"] != "free":
        end_epoch = int(datetime.fromisoformat(PERIOD_END.replace("Z", "+00:00")).timestamp())
        light = {
            "quota_ref": _light_ref(user_id), "schema_version": LIGHT_SCHEMA,
            "period_id": PERIOD_ID, "period_start": PERIOD_START, "period_end": PERIOD_END,
            "plan": target["plan"], "limit": target["light"], "used": 0,
            "reservations": [], "version": 1, "membership_version": 1,
            "created_at": migrated_at, "updated_at": migrated_at,
            "expires_at": end_epoch + 90 * 86400,
        }
        actions.append({"Put": {
            "TableName": context["light_table"], "Item": {key: _av(value) for key, value in light.items()},
            "ConditionExpression": "attribute_not_exists(quota_ref)",
        }})
    if target["plan"] == "premium":
        deep = {
            "quota_ref": _deep_ref(user_id, deep_secret), "schema_version": DEEP_SCHEMA,
            "period_key": PERIOD_ID, "limit": 3, "used": 0, "reservations": [],
            "version": 1, "created_at": migrated_at, "updated_at": migrated_at,
        }
        actions.append({"Put": {
            "TableName": context["deep_table"], "Item": {key: _av(value) for key, value in deep.items()},
            "ConditionExpression": "attribute_not_exists(quota_ref)",
        }})
    return actions


def _safe_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {key: sum(entry["status"] == key for entry in entries) for key in ("MIGRATABLE", "NO_OP", "CONFLICT", "UNKNOWN")}
    return {
        "environment": "production",
        "migration_id": MIGRATION_ID,
        "counts": counts,
        "targets": [
            {"user": _mask(entry["user_id"]), "classification": entry["target"]["classification"], "target_plan": entry["target"]["plan"], "status": entry["status"]}
            for entry in entries
        ],
        "manual_review": 0,
        "payment_mapping_created": 0,
        "source_records_deleted": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", default=REGION)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--diagnose", action="store_true")
    args = parser.parse_args()
    if args.profile != "nana-production-release-b" or args.region != REGION:
        raise RuntimeError("PROFILE_OR_REGION_BOUNDARY_MISMATCH")
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    context = _stack_context(session)
    dynamodb = session.client("dynamodb")
    deep_secret = _deep_secret(session, context["runtime_secret"])
    try:
        entries = _classify(dynamodb, context, _scan_users(dynamodb), deep_secret)
        summary = _safe_summary(entries)
        print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
        if args.diagnose:
            print(json.dumps({"diagnostics": _diagnose_conflicts(dynamodb, context, entries, deep_secret)}, ensure_ascii=False, separators=(",", ":")))
            return 0
        if not args.apply:
            return 0 if summary["counts"] == {"MIGRATABLE": 5, "NO_OP": 0, "CONFLICT": 0, "UNKNOWN": 0} else 2
        if summary["counts"] == {"MIGRATABLE": 0, "NO_OP": 5, "CONFLICT": 0, "UNKNOWN": 0}:
            print('{"apply":"NO_OP_ALREADY_COMPLETE","reconciled":5}')
            return 0
        if summary["counts"] != {"MIGRATABLE": 5, "NO_OP": 0, "CONFLICT": 0, "UNKNOWN": 0}:
            raise RuntimeError("MIGRATION_APPLY_GATE_FAILED")
        migrated_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for entry in entries:
            token = hashlib.sha256(f"{MIGRATION_ID}\0{entry['logical']}".encode("utf-8")).hexdigest()[:36]
            try:
                dynamodb.transact_write_items(
                    TransactItems=_transaction(context, entry, deep_secret, migrated_at),
                    ClientRequestToken=token,
                    ReturnConsumedCapacity="NONE",
                )
            except ClientError as error:
                code = error.response.get("Error", {}).get("Code", "UNKNOWN")
                raise RuntimeError(f"MIGRATION_TRANSACTION_FAILED:{code}") from None
        reconciled = _classify(dynamodb, context, _scan_users(dynamodb), deep_secret)
        final_summary = _safe_summary(reconciled)
        print(json.dumps(final_summary, ensure_ascii=False, separators=(",", ":")))
        if final_summary["counts"] != {"MIGRATABLE": 0, "NO_OP": 5, "CONFLICT": 0, "UNKNOWN": 0}:
            raise RuntimeError("MIGRATION_RECONCILIATION_FAILED")
        print('{"apply":"COMPLETE","applied":5,"reconciled":5}')
        return 0
    finally:
        deep_secret = ""


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        message = str(error)
        safe = message.split(":", 1)[0] if message else type(error).__name__
        if message.startswith("MIGRATION_TRANSACTION_FAILED:"):
            provider_code = message.split(":", 1)[1]
            if re.fullmatch(r"[A-Za-z][A-Za-z0-9]{2,63}", provider_code):
                safe = f"MIGRATION_TRANSACTION_FAILED_{provider_code}"
        print(json.dumps({"status": "BLOCKED", "safe_error": safe}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
