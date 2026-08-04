"""Read-only preflight for one existing staging Light Webhook reservation.

The script never prints provider payloads, resource identifiers, credentials, or
test-account identifiers. It proves that the already-created payment unit can be
resumed without creating a second customer, card, subscription, or payment.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import boto3


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
EXPECTED_ACCOUNT = "946385207519"
STACK = "nana-reading-staging"
TARGET_USER = "shirone-ui-light-20260804-v2@staging.invalid"
PROVIDER_ORIGIN = "https://api.test.fincode.jp"
EXPECTED_START_DATE = "2026/08/04"
PROVIDER_DATETIME = re.compile(r"^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$")

FALSE_PARAMETERS = (
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


class PreflightStopped(RuntimeError):
    pass


def stop(code: str) -> None:
    raise PreflightStopped(code)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_reference(prefix: str, user_id: str) -> str:
    raw = hashlib.sha256(f"shirone-fincode-test-light-browser-e2e-v2\0{user_id}".encode()).digest()
    encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return prefix + encoded[: 24 if prefix == "stg_customer_ui_" else 22]


def av_text(item: dict, key: str) -> str | None:
    value = item.get(key)
    return value.get("S") if isinstance(value, dict) and isinstance(value.get("S"), str) else None


def av_int(item: dict, key: str) -> int | None:
    value = item.get(key)
    raw = value.get("N") if isinstance(value, dict) else None
    return int(raw) if isinstance(raw, str) and raw.isdigit() else None


def av_bool(item: dict, key: str) -> bool | None:
    value = item.get(key)
    return value.get("BOOL") if isinstance(value, dict) and isinstance(value.get("BOOL"), bool) else None


def provider_request(secret_key: str, path: str) -> dict:
    url = urllib.parse.urljoin(PROVIDER_ORIGIN, path)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "api.test.fincode.jp":
        stop("PROVIDER_ORIGIN_REJECTED")
    request = urllib.request.Request(url, headers={
        "authorization": f"Bearer {secret_key}",
        "accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(1024 * 1024 + 1)
            if response.status != 200 or len(raw) > 1024 * 1024:
                stop("PROVIDER_RESPONSE_REJECTED")
    except (urllib.error.URLError, TimeoutError) as error:
        raise PreflightStopped("PROVIDER_READ_UNAVAILABLE") from error
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception as error:
        raise PreflightStopped("PROVIDER_RESPONSE_REJECTED") from error
    if not isinstance(body, dict):
        stop("PROVIDER_RESPONSE_REJECTED")
    return body


def canonical_parts(parts: list[str]) -> str:
    return "|".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)


def semantic_key(payload: dict) -> str:
    return digest(canonical_parts([
        "shirone-fincode-subscription-event-v1",
        "staging",
        payload["shop_id"],
        payload["event"],
        payload["subscription_id"],
        payload["process_date"],
        payload["status"],
    ]))


def payload_fingerprint(payload: dict) -> str:
    canonical = {
        "schema": "shirone-fincode-subscription-payload-v1",
        "environment": "staging",
        "event": payload["event"],
        "shop_id": payload["shop_id"],
        "subscription_id": payload["subscription_id"],
        "plan_id": payload["plan_id"],
        "customer_id": payload["customer_id"],
        "status": payload["status"],
        "process_date": payload["process_date"],
        "start_date": payload["start_date"],
        "stop_date": payload["stop_date"],
        "client_field_1": payload["client_field_1"],
        "client_field_2": payload["client_field_2"],
        "client_field_3": payload["client_field_3"],
    }
    return digest(json.dumps(canonical, ensure_ascii=False, separators=(",", ":")))


def tokyo_instant(value: object) -> str:
    if not isinstance(value, str) or not PROVIDER_DATETIME.fullmatch(value):
        stop("TRUSTED_PERIOD_UNRESOLVED")
    try:
        local = datetime.strptime(value, "%Y/%m/%d %H:%M:%S.%f").replace(
            tzinfo=timezone(timedelta(hours=9))
        )
    except ValueError as error:
        raise PreflightStopped("TRUSTED_PERIOD_UNRESOLVED") from error
    return local.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def secret_json(secrets, secret_id: str, expected_keys: tuple[str, ...]) -> dict:
    response = secrets.get_secret_value(SecretId=secret_id)
    if response.get("SecretBinary") is not None or not isinstance(response.get("SecretString"), str):
        stop("SECRET_CONTRACT_REJECTED")
    try:
        parsed = json.loads(response["SecretString"])
    except Exception as error:
        raise PreflightStopped("SECRET_CONTRACT_REJECTED") from error
    if not isinstance(parsed, dict) or tuple(sorted(parsed)) != tuple(sorted(expected_keys)):
        stop("SECRET_CONTRACT_REJECTED")
    return parsed


def webhook_signature(secrets, secret_id: str) -> str:
    response = secrets.get_secret_value(SecretId=secret_id)
    if response.get("SecretBinary") is not None or not isinstance(response.get("SecretString"), str):
        stop("WEBHOOK_SECRET_CONTRACT_REJECTED")
    raw = response["SecretString"]
    if raw.startswith("{"):
        try:
            parsed = json.loads(raw)
        except Exception as error:
            raise PreflightStopped("WEBHOOK_SECRET_CONTRACT_REJECTED") from error
        if not isinstance(parsed, dict) or tuple(parsed) != ("fincode_webhook_signature",):
            stop("WEBHOOK_SECRET_CONTRACT_REJECTED")
        value = parsed.get("fincode_webhook_signature")
    else:
        value = raw
    if not isinstance(value, str) or not value or len(value) > 4096 or any(char in value for char in "\r\n\0"):
        stop("WEBHOOK_SECRET_CONTRACT_REJECTED")
    return value


def collect_context(include_signature: bool = False) -> dict:
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    sts = session.client("sts")
    cfn = session.client("cloudformation")
    identity = sts.get_caller_identity()
    if identity.get("Account") != EXPECTED_ACCOUNT or ":assumed-role/AWSReservedSSO_AdministratorAccess_" not in str(identity.get("Arn")):
        stop("STAGING_ACCOUNT_BOUNDARY_REJECTED")

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
    required = (
        "ReadingUsersTable", "FincodeCustomerMappingTable", "FincodeLightQuotaTable",
        "FincodeWebhookLedgerTable", "FincodeWebhookFunction", "FincodeWebhookHttpApi",
        "LightEventSourceMapping", "DeepEventSourceMapping",
    )
    if any(name not in resources for name in required):
        stop("STAGING_RESOURCE_BOUNDARY_REJECTED")
    lambda_client = session.client("lambda")
    webhook_config = lambda_client.get_function_configuration(FunctionName=resources["FincodeWebhookFunction"])
    env = webhook_config.get("Environment", {}).get("Variables", {})
    runtime_flags = (
        "FINCODE_WEBHOOK_ENABLED", "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED", "FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED",
    )
    if any(env.get(key) != "false" for key in runtime_flags):
        stop("LAMBDA_FLAGS_NOT_FALSE")
    if env.get("FINCODE_WEBHOOK_ENVIRONMENT") != "staging" or env.get("FINCODE_CUSTOMER_REFERENCE_PREFIX") != "stg_customer_":
        stop("STAGING_RUNTIME_BOUNDARY_REJECTED")
    for logical in ("LightEventSourceMapping", "DeepEventSourceMapping"):
        if lambda_client.get_event_source_mapping(UUID=resources[logical]).get("State") != "Disabled":
            stop("WORKER_ESM_NOT_DISABLED")

    try:
        plan_mapping = json.loads(env["FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING"])
    except Exception as error:
        raise PreflightStopped("PLAN_MAPPING_REJECTED") from error
    light_plan_refs = [key for key, value in plan_mapping.items() if value == "light"] if isinstance(plan_mapping, dict) else []
    if len(light_plan_refs) != 1:
        stop("PLAN_MAPPING_REJECTED")
    plan_ref = light_plan_refs[0]

    secrets = session.client("secretsmanager")
    provider = secret_json(
        secrets,
        env.get("FINCODE_TEST_PROVIDER_SECRET_ID", ""),
        ("fincode_test_secret_key", "fincode_test_shop_id"),
    )
    provider_key = provider.get("fincode_test_secret_key")
    shop_id = provider.get("fincode_test_shop_id")
    if not isinstance(provider_key, str) or not provider_key.startswith("m_test_") or not isinstance(shop_id, str):
        stop("PROVIDER_SECRET_REJECTED")

    customer_ref = stable_reference("stg_customer_ui_", TARGET_USER)
    intent_ref = stable_reference("pi_", TARGET_USER)
    subscription_ref = stable_reference("su_", TARGET_USER)
    dynamo = session.client("dynamodb")
    mapping = dynamo.get_item(
        TableName=resources["FincodeCustomerMappingTable"],
        Key={"customer_ref_digest": {"S": digest(customer_ref)}},
        ConsistentRead=True,
    ).get("Item", {})
    mapping_ok = (
        av_text(mapping, "internal_user_id") == TARGET_USER
        and av_text(mapping, "environment") == "staging"
        and av_text(mapping, "mapping_status") == "ACTIVE"
        and av_int(mapping, "version") is not None and av_int(mapping, "version") >= 1
        and av_text(mapping, "customer_reference") == customer_ref
        and av_text(mapping, "checkout_schema_version") == "fincode-light-browser-e2e-v1"
        and av_text(mapping, "purchase_intent_id") == intent_ref
        and av_text(mapping, "expected_product") == "light"
        and av_int(mapping, "expected_amount") == 980
        and av_text(mapping, "expected_billing_type") == "subscription"
        and av_text(mapping, "expected_plan_reference") == plan_ref
        and av_text(mapping, "checkout_state") == "SUBMITTED"
        and av_text(mapping, "subscription_reference") == subscription_ref
    )
    if not mapping_ok:
        stop("IDENTITY_OR_PURCHASE_INTENT_CONFLICT")

    user = dynamo.get_item(
        TableName=resources["ReadingUsersTable"],
        Key={"user_id": {"S": TARGET_USER}},
        ConsistentRead=True,
    ).get("Item", {})
    grant_zero = (
        av_text(user, "user_id") == TARGET_USER
        and av_text(user, "membership_schema_version") == "shirone-membership-v1"
        and isinstance(av_int(user, "membership_version"), int)
        and av_int(user, "membership_version") >= 1
        and av_text(user, "plan") == "free"
        and av_text(user, "subscription_status") == "inactive"
        and av_bool(user, "deep_enabled") is False
        and av_int(user, "monthly_voice_limit") == 0
        and av_int(user, "monthly_voice_used") == 0
        and av_int(user, "extra_voice_remaining") == 0
    )
    if not grant_zero:
        stop("ENTITLEMENT_ALREADY_CHANGED_OR_CONFLICTED")

    trusted = provider_request(
        provider_key,
        f"/v1/subscriptions/{urllib.parse.quote(subscription_ref)}?pay_type=Card",
    )
    provider_ok = (
        trusted.get("id") == subscription_ref
        and trusted.get("shop_id") == shop_id
        and trusted.get("plan_id") == plan_ref
        and trusted.get("customer_id") == customer_ref
        and trusted.get("pay_type") == "Card"
        and trusted.get("status") in ("ACTIVE", "RUNNING")
        and isinstance(trusted.get("start_date"), str)
        and trusted["start_date"].startswith(EXPECTED_START_DATE + " ")
        and trusted.get("client_field_1") == "light"
        and trusted.get("client_field_2") == intent_ref
        and trusted.get("client_field_3") == "light-browser-e2e"
    )
    if not provider_ok or not PROVIDER_DATETIME.fullmatch(str(trusted.get("created", ""))):
        stop("PROVIDER_PAYMENT_UNIT_CONFLICT")

    period_start = tokyo_instant(trusted.get("start_date"))
    period_end = tokyo_instant(trusted.get("next_charge_date"))
    if datetime.fromisoformat(period_start.replace("Z", "+00:00")) >= datetime.fromisoformat(period_end.replace("Z", "+00:00")):
        stop("TRUSTED_PERIOD_UNRESOLVED")
    period_id = digest(f"fincode-contract-period-v1\0{period_start}\0{period_end}")
    quota_ref = digest(f"shirone-light-quota-v1\0{TARGET_USER}\0{period_id}")
    quota = dynamo.get_item(
        TableName=resources["FincodeLightQuotaTable"],
        Key={"quota_ref": {"S": quota_ref}},
        ConsistentRead=True,
    ).get("Item")
    if quota is not None:
        stop("QUOTA_ALREADY_EXISTS_OR_CONFLICTED")

    payload = {
        "shop_id": shop_id,
        "plan_id": plan_ref,
        "customer_id": customer_ref,
        "status": trusted["status"],
        "start_date": trusted.get("start_date"),
        "stop_date": trusted.get("stop_date"),
        "pay_type": "Card",
        "process_date": trusted["created"],
        "subscription_id": subscription_ref,
        "event": "subscription.card.regist",
        "client_field_1": trusted.get("client_field_1"),
        "client_field_2": trusted.get("client_field_2"),
        "client_field_3": trusted.get("client_field_3"),
    }
    matches: list[tuple[dict, str, str, dict]] = []
    statuses = [trusted["status"], "RUNNING" if trusted["status"] == "ACTIVE" else "ACTIVE"]
    process_dates = []
    for field in ("created", "updated"):
        value = trusted.get(field)
        if isinstance(value, str) and PROVIDER_DATETIME.fullmatch(value) and value not in process_dates:
            process_dates.append(value)
    for candidate_status in statuses:
        for process_date in process_dates:
            candidate = dict(payload)
            candidate["status"] = candidate_status
            candidate["process_date"] = process_date
            key = semantic_key(candidate)
            ledger = dynamo.get_item(
                TableName=resources["FincodeWebhookLedgerTable"],
                Key={"event_digest": {"S": key}},
                ConsistentRead=True,
            ).get("Item", {})
            if not ledger:
                continue
            with_clients = payload_fingerprint(candidate)
            without_clients_payload = dict(candidate)
            without_clients_payload.update({"client_field_1": None, "client_field_2": None, "client_field_3": None})
            without_clients = payload_fingerprint(without_clients_payload)
            stored = av_text(ledger, "payload_fingerprint")
            if stored == with_clients:
                matches.append((candidate, key, "provider_client_fields", ledger))
            elif stored == without_clients:
                matches.append((without_clients_payload, key, "null_client_fields", ledger))
            else:
                stop("LEDGER_PAYLOAD_FINGERPRINT_CONFLICT")
    if len(matches) != 1:
        stop("LEDGER_SEMANTIC_KEY_NOT_FOUND" if not matches else "LEDGER_MATCH_AMBIGUOUS")
    payload, key, payload_shape, ledger = matches[0]
    fingerprint = payload_fingerprint(payload)
    stored_fingerprint = av_text(ledger, "payload_fingerprint")
    same_reservation = (
        stored_fingerprint == fingerprint
        and av_text(ledger, "environment") == "staging"
        and av_text(ledger, "processing_state") == "RESERVED"
        and av_text(ledger, "result_code") == "RESERVED"
        and "completed_at" not in ledger
        and "mapped_user_digest" not in ledger
    )
    if not same_reservation:
        stop("LEDGER_RESERVATION_CONFLICT")
    now = int(time.time())
    lease = av_int(ledger, "reservation_expires_at")
    updated = av_text(ledger, "updated_at")
    stale = lease is not None and lease <= now
    if lease is None and isinstance(updated, str):
        try:
            stale = datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() + 300 <= now
        except ValueError:
            stale = False
    if not stale:
        stop("LEDGER_RESERVATION_NOT_STALE")

    signature = webhook_signature(secrets, env.get("FINCODE_WEBHOOK_SIGNATURE_SECRET_ID", "")) if include_signature else None
    safe_result = {
        "environment": "staging",
        "stack_update_complete": True,
        "cloudformation_flags_false": True,
        "lambda_flags_false": True,
        "worker_esm_disabled": True,
        "identity_boundary_match": True,
        "product_light": True,
        "amount_980": True,
        "subscription_active": True,
        "trusted_period_resolved": True,
        "payload_fingerprint_match": True,
        "payload_shape": payload_shape,
        "ledger_reserved_stale_resumable": True,
        "membership_grant_zero": True,
        "quota_grant_zero": True,
        "production_accesses": 0,
    }
    context = {
        "session": session,
        "cfn": cfn,
        "lambda_client": lambda_client,
        "dynamo": dynamo,
        "resources": resources,
        "parameters": parameters,
        "plan_mapping": plan_mapping,
        "payload": payload,
        "semantic_key": key,
        "payload_fingerprint": fingerprint,
        "period_start": period_start,
        "period_end": period_end,
        "period_id": period_id,
        "quota_ref": quota_ref,
        "membership_version": av_int(user, "membership_version"),
        "signature": signature,
        "safe_result": safe_result,
    }
    provider = provider_key = None
    return context


def main() -> None:
    context = collect_context(False)
    print(json.dumps(context["safe_result"], separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except PreflightStopped as error:
        print(json.dumps({"preflight": "BLOCKED", "safe_code": str(error), "production_accesses": 0}, separators=(",", ":")))
        raise SystemExit(2)
