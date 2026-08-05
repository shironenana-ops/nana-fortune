"""Read-only, value-free staging Secret ARN boundary diagnostics."""

from __future__ import annotations

import re

import boto3
from botocore.exceptions import ClientError


PROFILE = "shirone-staging"
REGION = "ap-northeast-1"
ACCOUNT = "946385207519"
STACK = "nana-reading-staging"
ARN = re.compile(
    r"^arn:aws:secretsmanager:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):secret:(?P<name>[A-Za-z0-9/_+=.@-]+)$"
)


def main() -> int:
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    identity = session.client("sts").get_caller_identity()
    if identity.get("Account") != ACCOUNT or ":root" in identity.get("Arn", ""):
        print("BOUNDARY_IDENTITY_MATCH=false")
        return 1
    stack = session.client("cloudformation").describe_stacks(StackName=STACK)["Stacks"][0]
    parameters = {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}
    runtime = parameters.get("RuntimeSecretsArn", "")
    webhook = parameters.get("FincodeWebhookSignatureSecretArn", "")
    runtime_match = ARN.fullmatch(runtime)
    webhook_match = ARN.fullmatch(webhook)
    runtime_name = runtime_match.group("name").lower() if runtime_match else ""
    webhook_name = webhook_match.group("name").lower() if webhook_match else ""
    checks = {
        "BOUNDARY_IDENTITY_MATCH": True,
        "RUNTIME_ARN_VALID": runtime_match is not None,
        "WEBHOOK_ARN_VALID": webhook_match is not None,
        "SECRET_ARNS_DISTINCT": runtime != webhook,
        "RUNTIME_REGION_ACCOUNT_MATCH": bool(runtime_match and runtime_match.group("region") == REGION and runtime_match.group("account") == ACCOUNT),
        "WEBHOOK_REGION_ACCOUNT_MATCH": bool(webhook_match and webhook_match.group("region") == REGION and webhook_match.group("account") == ACCOUNT),
        "RUNTIME_NAME_HAS_STAGING": "staging" in runtime_name,
        "RUNTIME_NAME_HAS_RUNTIME": "runtime" in runtime_name,
        "RUNTIME_NAME_HAS_READING": "reading" in runtime_name,
        "RUNTIME_NAME_HAS_FORBIDDEN_COMPONENT": any(token in runtime_name for token in ("fincode", "webhook", "signature", "prod", "production")),
        "WEBHOOK_NAME_HAS_STAGING": "staging" in webhook_name,
        "WEBHOOK_NAME_HAS_FINCODE": "fincode" in webhook_name,
        "WEBHOOK_NAME_HAS_SIGNATURE_COMPONENT": any(token in webhook_name for token in ("webhook", "signature")),
        "WEBHOOK_NAME_HAS_PRODUCTION": any(token in webhook_name for token in ("prod", "production")),
    }
    for key, value in checks.items():
        print(f"{key}={str(value).lower()}")

    secrets = session.client("secretsmanager")
    response = secrets.list_secrets(Filters=[
        {"Key": "tag-value", "Values": ["staging"]},
    ])
    items = response.get("SecretList", [])
    project_environment = []
    component = []
    allowed = []
    dedicated_webhook = []
    test_provider = []
    for item in items:
        item_tags = {tag.get("Key", ""): tag.get("Value", "") for tag in item.get("Tags", [])}
        name = str(item.get("Name", "")).lower()
        if item_tags.get("Project") == "nana-fortune" and item_tags.get("Environment") == "staging":
            project_environment.append(item)
        if any(value in name for value in ("runtime", "reading")):
            component.append(item)
        if (
            item_tags.get("Project") == "nana-fortune"
            and item_tags.get("Environment") == "staging"
            and any(value in name for value in ("runtime", "reading"))
            and not any(value in name for value in ("fincode", "webhook", "provider", "signature", "prod", "production"))
            and isinstance(item.get("ARN"), str)
        ):
            allowed.append(item)
        if (
            item_tags.get("Project") == "nana-fortune"
            and item_tags.get("Environment") == "staging"
            and "fincode" in name
            and any(value in name for value in ("webhook", "signature"))
            and not any(value in name for value in ("runtime", "provider", "prod", "production"))
            and isinstance(item.get("ARN"), str)
        ):
            dedicated_webhook.append(item)
        if "provider" in name:
            test_provider.append(item)
    print(f"FILTERED_SECRET_COUNT={len(items)}")
    print(f"PROJECT_ENVIRONMENT_MATCH_COUNT={len(project_environment)}")
    print(f"RUNTIME_COMPONENT_MATCH_COUNT={len(component)}")
    print(f"FINAL_RUNTIME_CANDIDATE_COUNT={len(allowed)}")
    print(f"DEDICATED_WEBHOOK_CANDIDATE_COUNT={len(dedicated_webhook)}")
    print(f"TEST_PROVIDER_COMPONENT_COUNT={len(test_provider)}")
    expected_dedicated = None
    try:
        expected_dedicated = secrets.describe_secret(
            SecretId="shirone7/staging/fincode/webhook-signature"
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
    expected_tags = {
        tag.get("Key", ""): tag.get("Value", "")
        for tag in (expected_dedicated or {}).get("Tags", [])
    }
    expected_arn = str((expected_dedicated or {}).get("ARN", ""))
    expected_match = ARN.fullmatch(expected_arn)
    print(f"EXPECTED_DEDICATED_SECRET_FOUND={str(expected_dedicated is not None).lower()}")
    print(f"EXPECTED_DEDICATED_ACCOUNT_REGION_MATCH={str(bool(expected_match and expected_match.group('region') == REGION and expected_match.group('account') == ACCOUNT)).lower()}")
    print(f"EXPECTED_DEDICATED_PROJECT_TAG_MATCH={str(expected_tags.get('Project') == 'nana-fortune').lower()}")
    print(f"EXPECTED_DEDICATED_ENVIRONMENT_TAG_MATCH={str(expected_tags.get('Environment') == 'staging').lower()}")
    named_response = secrets.list_secrets(Filters=[
        {"Key": "name", "Values": ["shirone7/staging/fincode"]},
    ])
    named_items = named_response.get("SecretList", [])
    named_dedicated = []
    named_dedicated_tagged = []
    for item in named_items:
        name = str(item.get("Name", "")).lower()
        item_tags = {tag.get("Key", ""): tag.get("Value", "") for tag in item.get("Tags", [])}
        if (
            any(value in name for value in ("webhook", "signature"))
            and "provider" not in name
            and isinstance(item.get("ARN"), str)
        ):
            named_dedicated.append(item)
            if item_tags.get("Project") == "nana-fortune" and item_tags.get("Environment") == "staging":
                named_dedicated_tagged.append(item)
    print(f"STAGING_FINCODE_NAME_PREFIX_COUNT={len(named_items)}")
    print(f"NAME_CLASSIFIED_DEDICATED_COUNT={len(named_dedicated)}")
    print(f"NAME_CLASSIFIED_DEDICATED_TAG_MATCH_COUNT={len(named_dedicated_tagged)}")
    resources = {}
    response = session.client("cloudformation").list_stack_resources(StackName=STACK)
    for item in response.get("StackResourceSummaries", []):
        resources[item.get("LogicalResourceId", "")] = item.get("PhysicalResourceId", "")
    webhook_function = resources.get("FincodeWebhookFunction", "")
    webhook_reference = ""
    if webhook_function:
        configuration = session.client("lambda").get_function_configuration(FunctionName=webhook_function)
        webhook_reference = configuration.get("Environment", {}).get("Variables", {}).get("FINCODE_WEBHOOK_SIGNATURE_SECRET_ID", "")
    runtime_reference = allowed[0].get("ARN", "") if len(allowed) == 1 else ""
    deployed_runtime = ARN.fullmatch(runtime_reference)
    deployed_webhook = ARN.fullmatch(webhook_reference)
    deployed_runtime_name = deployed_runtime.group("name").lower() if deployed_runtime else ""
    deployed_webhook_name = deployed_webhook.group("name").lower() if deployed_webhook else ""
    print(f"DEPLOYED_RUNTIME_ARN_VALID={str(deployed_runtime is not None).lower()}")
    print(f"DEPLOYED_WEBHOOK_ARN_VALID={str(deployed_webhook is not None).lower()}")
    print(f"DEPLOYED_SECRET_ARNS_DISTINCT={str(runtime_reference != webhook_reference).lower()}")
    print(f"DEPLOYED_RUNTIME_HAS_RUNTIME={str('runtime' in deployed_runtime_name).lower()}")
    print(f"DEPLOYED_RUNTIME_HAS_READING={str('reading' in deployed_runtime_name).lower()}")
    print(f"DEPLOYED_WEBHOOK_HAS_FINCODE={str('fincode' in deployed_webhook_name).lower()}")
    print(f"DEPLOYED_WEBHOOK_HAS_WEBHOOK={str('webhook' in deployed_webhook_name).lower()}")
    print(f"DEPLOYED_WEBHOOK_HAS_SIGNATURE={str('signature' in deployed_webhook_name).lower()}")
    fincode_flag_names = (
        "FincodeWebhookEnabled",
        "FincodePeriodSourceEnabled",
        "FincodeProvisionalTestPeriodSourceEnabled",
        "FincodeOneTimeVoiceWebhookEnabled",
    )
    auth_flag_names = (
        "StagingLoginEnabled",
        "StagingSignupEnabled",
        "StagingMembershipStatusEnabled",
    )
    print(f"STACK_STATUS_STABLE={str(stack.get('StackStatus') in {'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'}).lower()}")
    print(f"AUTH_FLAGS_FALSE={str(all(parameters.get(name) == 'false' for name in auth_flag_names)).lower()}")
    print(f"FINCODE_FLAGS_FALSE={str(all(parameters.get(name) == 'false' for name in fincode_flag_names)).lower()}")
    print(f"READING_LIGHT_QUOTA_FALSE={str(parameters.get('ReadingLightQuotaEnabled') == 'false').lower()}")
    print(f"BEDROCK_FALSE={str(parameters.get('ReadingBedrockEnabled') == 'false').lower()}")
    lambda_client = session.client("lambda")
    esm_states = []
    for logical_id in ("LightEventSourceMapping", "DeepEventSourceMapping"):
        physical_id = resources.get(logical_id, "")
        if physical_id:
            esm_states.append(lambda_client.get_event_source_mapping(UUID=physical_id).get("State"))
    print(f"WORKER_ESM_DISABLED={str(esm_states == ['Disabled', 'Disabled']).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
