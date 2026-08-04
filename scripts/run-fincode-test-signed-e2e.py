import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3

REGION = "ap-northeast-1"
PROFILE = "shirone-staging"
STACK = "nana-reading-staging"
ORIGIN = "https://api.test.fincode.jp"
SECRET_NAME = "shirone7/staging/fincode/test-provider"
CUSTOMERS = {
    "light": "stg_customer_e2e_light_20260803_00001",
    "premium": "stg_customer_e2e_premium_20260803_001",
}
USERS = {
    "light": "fincode-staging-e2e-light-20260803",
    "premium": "fincode-staging-e2e-premium-20260803",
}
EVENTS = ("subscription.card.regist", "payments.card.exec", "payments.card.capture", "payments.card.secure")
PROVIDER_DATETIME = re.compile(r"^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$")


def stop(code):
    raise RuntimeError(code)


def provider_request(key, path, method="GET", body=None):
    url = urllib.parse.urljoin(ORIGIN, path)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "api.test.fincode.jp":
        stop("FINCODE_TEST_ORIGIN_REJECTED")
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, method=method, data=data, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                stop("FINCODE_TEST_RESPONSE_TOO_LARGE")
            return response.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return error.code, None
        try:
            return error.code, json.loads(raw.decode("utf-8"))
        except Exception:
            return error.code, None


def api_post(url, signature, body):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc.endswith(".execute-api.ap-northeast-1.amazonaws.com"):
        stop("STAGING_WEBHOOK_URL_REJECTED")
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, method="POST", data=data, headers={
        "Content-Type": "application/json", "Fincode-Signature": signature
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def exact_plan(plans, amount):
    found = [p for p in plans if str(p.get("amount")) == str(amount) and str(p.get("tax")) == "0"
             and p.get("interval_pattern") == "month" and int(p.get("interval_count", 0)) == 1
             and p.get("delete_flag") != "1" and isinstance(p.get("id"), str)]
    if len(found) != 1:
        stop("FINCODE_TEST_PLAN_CONTRACT_INVALID")
    return found[0]["id"]


def find_existing_captured_voice_payment(key, shop, dynamo, table_name):
    stored = dynamo.scan(TableName=table_name, ProjectionExpression="payment_digest, processing_state").get("Items", [])
    registered = {
        item.get("payment_digest", {}).get("S")
        for item in stored
        if item.get("processing_state", {}).get("S") == "REGISTERED"
    }
    registered.discard(None)
    path = "/v1/payments?pay_type=Card&limit=100&page=1"
    matches = []
    for _ in range(20):
        status, body = provider_request(key, path)
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("list"), list):
            stop("FINCODE_TEST_PAYMENT_LIST_FAILED")
        for payment in body["list"]:
            if not isinstance(payment, dict) or not isinstance(payment.get("id"), str):
                continue
            payment_id = payment["id"]
            payment_digest = digest("\0".join(("fincode-one-time-voice-v1", "staging", shop, payment_id)))
            if payment_digest not in registered:
                continue
            code, trusted = provider_request(key, f"/v1/payments/{urllib.parse.quote(payment_id)}?pay_type=Card")
            if code == 200 and isinstance(trusted, dict) and trusted.get("shop_id") == shop and trusted.get("amount") == 300 and trusted.get("tax") == 0 and trusted.get("pay_type") == "Card" and trusted.get("job_code") == "CAPTURE" and trusted.get("status") == "CAPTURED":
                matches.append(payment_id)
        next_link = body.get("link_next")
        if not isinstance(next_link, str) or not next_link:
            break
        parsed = urllib.parse.urlparse(next_link)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/v1/payments"):
            stop("FINCODE_TEST_PAYMENT_PAGINATION_REJECTED")
        path = parsed.path + ("?" + parsed.query if parsed.query else "")
    if len(matches) > 1:
        stop("FINCODE_TEST_REGISTERED_PAYMENT_AMBIGUOUS")
    return matches[0] if matches else None


def wait_stack(cfn, expected):
    for _ in range(120):
        status = cfn.describe_stacks(StackName=STACK)["Stacks"][0]["StackStatus"]
        if status == expected:
            return
        if "FAILED" in status or "ROLLBACK" in status:
            stop("STAGING_STACK_UPDATE_FAILED")
        time.sleep(3)
    stop("STAGING_STACK_UPDATE_TIMEOUT")


def flags_are_false(lambda_client, function_name):
    variables = lambda_client.get_function_configuration(FunctionName=function_name).get("Environment", {}).get("Variables", {})
    keys = (
        "FINCODE_WEBHOOK_ENABLED",
        "FINCODE_PERIOD_SOURCE_ENABLED",
        "FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED",
        "FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED",
    )
    return all(variables.get(key) == "false" for key in keys)


def update_flags(cfn, plan_mapping, enabled):
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    parameters = []
    changed = {
        "FincodeWebhookEnabled": str(enabled).lower(),
        "FincodePeriodSourceEnabled": str(enabled).lower(),
        "FincodeProvisionalTestPeriodSourceEnabled": str(enabled).lower(),
        "FincodeOneTimeVoiceWebhookEnabled": str(enabled).lower(),
        "FincodeAllowedPlanMapping": json.dumps(plan_mapping, separators=(",", ":")),
    }
    for item in stack["Parameters"]:
        key = item["ParameterKey"]
        parameters.append({"ParameterKey": key, "ParameterValue": changed[key]} if key in changed else {"ParameterKey": key, "UsePreviousValue": True})
    name = f"fincode-test-e2e-{'enable' if enabled else 'disable'}-{int(time.time())}"
    body = open("infrastructure/reading-staging/template.json", "r", encoding="utf-8").read()
    cfn.create_change_set(StackName=STACK, ChangeSetName=name, ChangeSetType="UPDATE", TemplateBody=body,
                          Parameters=parameters, Capabilities=["CAPABILITY_NAMED_IAM"], Description="staging fincode TEST E2E temporary flags")
    for _ in range(80):
        detail = cfn.describe_change_set(StackName=STACK, ChangeSetName=name)
        if detail["Status"] == "CREATE_COMPLETE":
            break
        if detail["Status"] == "FAILED":
            if "didn't contain changes" in detail.get("StatusReason", ""):
                return False
            stop("STAGING_CHANGE_SET_CREATE_FAILED")
        time.sleep(2)
    else:
        stop("STAGING_CHANGE_SET_TIMEOUT")
    changes = detail.get("Changes", [])
    allowed = {"FincodeWebhookFunction": "AWS::Lambda::Function", "FincodeWebhookIntegration": "AWS::ApiGatewayV2::Integration"}
    if any(c.get("Type") != "Resource" or c["ResourceChange"].get("Action") != "Modify"
           or allowed.get(c["ResourceChange"].get("LogicalResourceId")) != c["ResourceChange"].get("ResourceType")
           or c["ResourceChange"].get("Replacement") not in ("False", False) for c in changes):
        stop("STAGING_CHANGE_SET_SCOPE_REJECTED")
    cfn.execute_change_set(StackName=STACK, ChangeSetName=name)
    wait_stack(cfn, "UPDATE_COMPLETE")
    return True


def main():
    if sys.argv[1:] != ["--execute-staging-test"] or os.environ.get("AWS_PROFILE") != PROFILE or os.environ.get("AWS_REGION") != REGION:
        stop("STAGING_TEST_GUARD_REJECTED")
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    sts, cfn = session.client("sts"), session.client("cloudformation")
    identity = sts.get_caller_identity()
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack["StackStatus"] != "UPDATE_COMPLETE" or identity["Account"] not in stack["StackId"]:
        stop("STAGING_ACCOUNT_BOUNDARY_REJECTED")
    resources = {r["LogicalResourceId"]: r["PhysicalResourceId"] for r in cfn.describe_stack_resources(StackName=STACK)["StackResources"]}
    required = ("ReadingUsersTable", "FincodeCustomerMappingTable", "FincodeOneTimeVoicePurchaseTable", "FincodeWebhookHttpApi", "FincodeWebhookFunction")
    if any(key not in resources for key in required):
        stop("STAGING_RESOURCE_BOUNDARY_REJECTED")
    params = {p["ParameterKey"]: p.get("ParameterValue") for p in stack["Parameters"]}
    lambda_config = session.client("lambda").get_function_configuration(FunctionName=resources["FincodeWebhookFunction"])
    runtime_env = lambda_config.get("Environment", {}).get("Variables", {})
    if runtime_env.get("FINCODE_CUSTOMER_REFERENCE_PREFIX") != "stg_customer_":
        stop("STAGING_CUSTOMER_PREFIX_REJECTED")
    secrets = session.client("secretsmanager")
    provider_raw = secrets.get_secret_value(SecretId=SECRET_NAME).get("SecretString")
    provider = json.loads(provider_raw or "")
    provider_raw = None
    key, shop = provider.get("fincode_test_secret_key"), provider.get("fincode_test_shop_id")
    if not isinstance(key, str) or not key.startswith("m_test_") or not isinstance(shop, str) or not shop.startswith("s_"):
        stop("FINCODE_TEST_PROVIDER_SECRET_INVALID")
    status, plan_body = provider_request(key, "/v1/plans")
    if status != 200 or not isinstance(plan_body, dict) or not isinstance(plan_body.get("list"), list):
        stop("FINCODE_TEST_PLAN_LIST_FAILED")
    plan_mapping = {exact_plan(plan_body["list"], 980): "light", exact_plan(plan_body["list"], 2980): "premium"}
    api = session.client("apigatewayv2").get_api(ApiId=resources["FincodeWebhookHttpApi"])
    endpoint = api.get("ApiEndpoint")
    if not isinstance(endpoint, str):
        stop("STAGING_WEBHOOK_ENDPOINT_INVALID")
    webhook_url = endpoint.rstrip("/") + "/staging/webhooks/fincode"
    status, settings_body = provider_request(key, "/v1/webhook_settings")
    if status != 200 or not isinstance(settings_body, dict) or not isinstance(settings_body.get("list"), list):
        stop("FINCODE_TEST_WEBHOOK_LIST_FAILED")
    signatures = set()
    for event in EVENTS:
        exact = [w for w in settings_body["list"] if w.get("event") == event and w.get("url") == webhook_url and isinstance(w.get("id"), str)]
        if len(exact) != 1 or not isinstance(exact[0].get("signature"), str) or not exact[0]["signature"]:
            stop("FINCODE_TEST_WEBHOOK_EXISTING_CONTRACT_INVALID")
        signatures.add(exact[0]["signature"])
    if len(signatures) != 1:
        stop("FINCODE_TEST_WEBHOOK_SIGNATURE_CONFLICT")
    signature = signatures.pop()
    if not isinstance(runtime_env.get("FINCODE_WEBHOOK_SIGNATURE_SECRET_ID"), str) or not runtime_env["FINCODE_WEBHOOK_SIGNATURE_SECRET_ID"]:
        stop("STAGING_WEBHOOK_SIGNATURE_SECRET_BOUNDARY_REJECTED")
    dynamo = session.client("dynamodb")
    for plan, customer in CUSTOMERS.items():
        user = USERS[plan]
        existing_user = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": user}}, ConsistentRead=True).get("Item")
        if not existing_user or existing_user.get("plan", {}).get("S") != "free" or existing_user.get("subscription_status", {}).get("S") != "inactive":
            stop("STAGING_USER_FIXTURE_CONFLICT")
        existing_mapping = dynamo.get_item(TableName=resources["FincodeCustomerMappingTable"], Key={"customer_ref_digest": {"S": digest(customer)}}, ConsistentRead=True).get("Item")
        if not existing_mapping or existing_mapping.get("internal_user_id", {}).get("S") != user or existing_mapping.get("environment", {}).get("S") != "staging":
            stop("STAGING_CUSTOMER_MAPPING_CONFLICT")
    subscription_records = []
    for plan, customer in CUSTOMERS.items():
        plan_id = next(ref for ref, mapped in plan_mapping.items() if mapped == plan)
        query = urllib.parse.urlencode({"pay_type": "Card", "plan_id": plan_id, "customer_id": customer})
        status, response = provider_request(key, "/v1/subscriptions?" + query)
        if status != 200 or not isinstance(response, dict) or not isinstance(response.get("list"), list):
            stop("FINCODE_TEST_SUBSCRIPTION_LIST_FAILED")
        exact = [item for item in response["list"] if isinstance(item, dict) and item.get("customer_id") == customer and item.get("plan_id") == plan_id and isinstance(item.get("id"), str)]
        if len(exact) != 1:
            stop("FINCODE_TEST_EXISTING_SUBSCRIPTION_CONTRACT_INVALID")
        subscription_id = exact[0]["id"]
        status, trusted = provider_request(key, f"/v1/subscriptions/{urllib.parse.quote(subscription_id)}?pay_type=Card")
        if status != 200 or not isinstance(trusted, dict) or trusted.get("id") != subscription_id or trusted.get("customer_id") != customer or trusted.get("plan_id") != plan_id or trusted.get("start_date") is None or trusted.get("next_charge_date") is None:
            stop("FINCODE_TEST_TRUSTED_PERIOD_UNAVAILABLE")
        subscription_records.append(trusted)
    lambda_client = session.client("lambda")
    if not flags_are_false(lambda_client, resources["FincodeWebhookFunction"]):
        stop("STAGING_FLAGS_NOT_FALSE_AT_START")
    enable_attempted = False
    result = None
    try:
        enable_attempted = True
        update_flags(cfn, plan_mapping, True)
        subscription_statuses = []
        subscription_payloads = []
        for trusted in subscription_records:
            payload = {key_name: trusted.get(key_name) for key_name in (
                "shop_id", "plan_id", "customer_id", "status", "start_date", "stop_date", "pay_type"
            )}
            # The subscription GET response omits Webhook-only process_date. For this signed
            # staging replay, use the provider-issued immutable registration timestamp only;
            # it is never used as the membership period source.
            payload["process_date"] = trusted.get("created")
            if not isinstance(payload["process_date"], str) or not PROVIDER_DATETIME.fullmatch(payload["process_date"]):
                stop("FINCODE_TEST_SUBSCRIPTION_EVENT_TIME_UNAVAILABLE")
            payload["subscription_id"] = trusted.get("id")
            payload["event"] = "subscription.card.regist"
            subscription_payloads.append(payload)
            subscription_statuses.append(api_post(webhook_url, signature, payload))
        subscriptions_verified = all(code == 200 for code in subscription_statuses)
        subscriptions_blocked_unstarted = all(code == 503 for code in subscription_statuses)
        if not subscriptions_verified and not subscriptions_blocked_unstarted:
            stop("FINCODE_TEST_SIGNED_SUBSCRIPTION_WEBHOOK_FAILED")
        if subscriptions_verified:
            expected = {"light": ("light", "active", "3", False), "premium": ("premium", "active", "10", True)}
            verified = set()
            for _ in range(60):
                for plan, user in USERS.items():
                    item = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": user}}, ConsistentRead=True).get("Item", {})
                    exp = expected[plan]
                    if item.get("plan", {}).get("S") == exp[0] and item.get("subscription_status", {}).get("S") == exp[1] and item.get("monthly_voice_limit", {}).get("N") == exp[2] and item.get("deep_enabled", {}).get("BOOL") is exp[3]:
                        verified.add(plan)
                if len(verified) == 2:
                    break
                time.sleep(2)
            if len(verified) != 2:
                stop("FINCODE_TEST_SUBSCRIPTION_WEBHOOK_NOT_VERIFIED")
        else:
            for user in USERS.values():
                item = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": user}}, ConsistentRead=True).get("Item", {})
                if item.get("plan", {}).get("S") != "free" or item.get("subscription_status", {}).get("S") != "inactive":
                    stop("FINCODE_TEST_UNSTARTED_SUBSCRIPTION_MUTATED")

        # Signed subscription mismatch checks must not mutate either fixture.
        wrong_plan = dict(subscription_payloads[0])
        wrong_plan["plan_id"] = subscription_payloads[1]["plan_id"]
        wrong_owner = dict(subscription_payloads[0])
        wrong_owner["customer_id"] = subscription_payloads[1]["customer_id"]
        if api_post(webhook_url, signature, wrong_plan) != 409 or api_post(webhook_url, signature, wrong_owner) != 409:
            stop("FINCODE_TEST_SUBSCRIPTION_MISMATCH_NOT_CLOSED")

        premium_before = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": USERS["premium"]}}, ConsistentRead=True).get("Item", {})
        if premium_before.get("extra_voice_remaining", {}).get("N") != "0":
            stop("FINCODE_TEST_VOICE_BASELINE_CONFLICT")

        # Wrong amount: even a captured provider payment is rejected before intent lookup.
        status, wrong_amount = provider_request(key, "/v1/payments", "POST", {"pay_type": "Card", "job_code": "CAPTURE", "amount": "301", "tax": "0"})
        if status != 200 or not isinstance(wrong_amount, dict) or not isinstance(wrong_amount.get("id"), str) or not isinstance(wrong_amount.get("access_id"), str):
            stop("FINCODE_TEST_WRONG_AMOUNT_REGISTER_FAILED")
        status, _ = provider_request(key, f"/v1/payments/{wrong_amount['id']}", "PUT", {"pay_type": "Card", "access_id": wrong_amount["access_id"], "customer_id": CUSTOMERS["premium"], "method": "1"})
        if status != 200 or api_post(webhook_url, signature, {"event": "payments.card.exec", "pay_type": "Card", "order_id": wrong_amount["id"]}) != 503:
            stop("FINCODE_TEST_WRONG_AMOUNT_NOT_CLOSED")

        # Failed/unprocessed payment: provider state is not successful, so no grant.
        status, unprocessed = provider_request(key, "/v1/payments", "POST", {"pay_type": "Card", "job_code": "CAPTURE", "amount": "300", "tax": "0"})
        if status != 200 or not isinstance(unprocessed, dict) or not isinstance(unprocessed.get("id"), str):
            stop("FINCODE_TEST_UNPROCESSED_REGISTER_FAILED")
        if api_post(webhook_url, signature, {"event": "payments.card.exec", "pay_type": "Card", "order_id": unprocessed["id"]}) != 503:
            stop("FINCODE_TEST_FAILED_PAYMENT_NOT_CLOSED")

        # Ownership/intent mismatch: captured payment without a matching registered intent.
        status, unowned = provider_request(key, "/v1/payments", "POST", {"pay_type": "Card", "job_code": "CAPTURE", "amount": "300", "tax": "0"})
        if status != 200 or not isinstance(unowned, dict) or not isinstance(unowned.get("id"), str) or not isinstance(unowned.get("access_id"), str):
            stop("FINCODE_TEST_UNOWNED_REGISTER_FAILED")
        status, _ = provider_request(key, f"/v1/payments/{unowned['id']}", "PUT", {"pay_type": "Card", "access_id": unowned["access_id"], "customer_id": CUSTOMERS["light"], "method": "1"})
        ownership_status = api_post(webhook_url, signature, {"event": "payments.card.exec", "pay_type": "Card", "order_id": unowned["id"]})
        if status != 200 or ownership_status not in (409, 503):
            stop("FINCODE_TEST_OWNERSHIP_MISMATCH_NOT_CLOSED")
        premium_after_negative = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": USERS["premium"]}}, ConsistentRead=True).get("Item", {})
        if premium_after_negative.get("extra_voice_remaining", {}).get("N") != "0":
            stop("FINCODE_TEST_NEGATIVE_CASE_GRANTED")

        # Resume an already-captured REGISTERED intent after a safe stop; otherwise
        # register the durable intent before executing a new provider payment.
        payment_id = find_existing_captured_voice_payment(key, shop, dynamo, resources["FincodeOneTimeVoicePurchaseTable"])
        if payment_id is None:
            status, payment = provider_request(key, "/v1/payments", "POST", {"pay_type": "Card", "job_code": "CAPTURE", "amount": "300", "tax": "0"})
            if status != 200 or not isinstance(payment, dict) or not isinstance(payment.get("id"), str) or not isinstance(payment.get("access_id"), str):
                stop("FINCODE_TEST_PAYMENT_REGISTER_FAILED")
            payment_id = payment["id"]
            payment_digest = digest("\0".join(("fincode-one-time-voice-v1", "staging", shop, payment_id)))
            fingerprint = digest("\0".join(("fincode-one-time-voice-payload-v1", "staging", shop, payment_id, "300", "Card", "CAPTURE", "CAPTURED")))
            shop_digest = digest("fincode-one-time-voice-shop-v1\0" + shop)
            dynamo.put_item(TableName=resources["FincodeOneTimeVoicePurchaseTable"], Item={
                "payment_digest": {"S": payment_digest}, "payload_fingerprint": {"S": fingerprint},
                "user_reference": {"S": USERS["premium"]}, "environment": {"S": "staging"},
                "shop_digest": {"S": shop_digest}, "product": {"S": "voice_single"}, "amount": {"N": "300"},
                "processing_state": {"S": "REGISTERED"}, "schema_version": {"S": "shirone-fincode-one-time-voice-v1"}, "version": {"N": "1"},
            }, ConditionExpression="attribute_not_exists(payment_digest)")
            status, executed = provider_request(key, f"/v1/payments/{payment_id}", "PUT", {
                "pay_type": "Card", "access_id": payment["access_id"], "customer_id": CUSTOMERS["premium"], "method": "1"
            })
            if status != 200 or not isinstance(executed, dict):
                stop("FINCODE_TEST_PAYMENT_EXEC_FAILED")
        payment_digest = digest("\0".join(("fincode-one-time-voice-v1", "staging", shop, payment_id)))
        if api_post(webhook_url, signature, {"event": "payments.card.exec", "pay_type": "Card", "order_id": payment_id}) != 200:
            stop("FINCODE_TEST_ONE_TIME_VOICE_SIGNED_WEBHOOK_FAILED")
        for _ in range(40):
            item = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": USERS["premium"]}}, ConsistentRead=True).get("Item", {})
            purchase = dynamo.get_item(TableName=resources["FincodeOneTimeVoicePurchaseTable"], Key={"payment_digest": {"S": payment_digest}}, ConsistentRead=True).get("Item", {})
            if item.get("extra_voice_remaining", {}).get("N") == "1" and purchase.get("processing_state", {}).get("S") == "COMPLETED":
                break
            time.sleep(2)
        else:
            stop("FINCODE_TEST_ONE_TIME_VOICE_WEBHOOK_NOT_VERIFIED")
        duplicate_body = {"event": "payments.card.exec", "pay_type": "Card", "order_id": payment_id}
        duplicate_statuses = []
        for _ in range(10):
            duplicate_statuses.append(api_post(webhook_url, signature, duplicate_body))
            time.sleep(0.3)
        item = dynamo.get_item(TableName=resources["ReadingUsersTable"], Key={"user_id": {"S": USERS["premium"]}}, ConsistentRead=True).get("Item", {})
        if item.get("extra_voice_remaining", {}).get("N") != "1" or any(code != 200 for code in duplicate_statuses):
            stop("FINCODE_TEST_DUPLICATE_GRANT_FAILED")
        result = {
            "environment": "staging/fincode TEST", "light_subscription_verified": subscriptions_verified,
            "premium_subscription_verified": subscriptions_verified, "subscriptions_blocked_unstarted_period": subscriptions_blocked_unstarted,
            "voice_single_exactly_once": True, "duplicate_delivery_count": 10,
            "wrong_amount_fail_closed": True, "wrong_plan_fail_closed": True,
            "ownership_mismatch_fail_closed": True, "failed_payment_fail_closed": True,
            "provisional_contract_period_source": "Asia/Tokyo", "production_tz_confirmed": False,
            "production_accesses": 0,
        }
    finally:
        if enable_attempted:
            update_flags(cfn, plan_mapping, False)
        if not flags_are_false(lambda_client, resources["FincodeWebhookFunction"]):
            stop("STAGING_FLAGS_RESTORE_NOT_VERIFIED")
        provider = key = signature = None
    if result is None:
        stop("FINCODE_TEST_RESULT_NOT_AVAILABLE")
    result["flags_restored_false"] = True
    print(json.dumps(result, separators=(",", ":")))


def emergency_disable():
    if os.environ.get("AWS_PROFILE") != PROFILE or os.environ.get("AWS_REGION") != REGION:
        stop("STAGING_TEST_GUARD_REJECTED")
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    cfn = session.client("cloudformation")
    stack = cfn.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack["StackStatus"] != "UPDATE_COMPLETE" or session.client("sts").get_caller_identity()["Account"] not in stack["StackId"]:
        stop("STAGING_ACCOUNT_BOUNDARY_REJECTED")
    resources = {r["LogicalResourceId"]: r["PhysicalResourceId"] for r in cfn.describe_stack_resources(StackName=STACK)["StackResources"]}
    runtime_env = session.client("lambda").get_function_configuration(FunctionName=resources["FincodeWebhookFunction"]).get("Environment", {}).get("Variables", {})
    try:
        plan_mapping = json.loads(runtime_env["FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING"])
    except Exception:
        stop("STAGING_PLAN_MAPPING_UNAVAILABLE")
    update_flags(cfn, plan_mapping, False)
    print(json.dumps({"environment": "staging", "fincode_flags_restored_false": True, "production_accesses": 0}, separators=(",", ":")))


if __name__ == "__main__":
    if sys.argv[1:] == ["--disable-staging-test"]:
        emergency_disable()
    else:
        main()
