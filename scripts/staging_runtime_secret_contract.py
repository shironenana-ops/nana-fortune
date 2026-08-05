"""Fail-closed contract helpers for the staging Runtime Secret repair.

This module is intentionally free of AWS calls and logging. Callers may pass
secret values in memory, but this module never serializes or reports them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping


REGION = "ap-northeast-1"
CANONICAL_KEYS = (
    "session_token_secret",
    "audit_hash_secret",
    "reading_idempotency_hash_secret",
    "reading_deep_quota_hash_secret",
)
WEBHOOK_SIGNATURE_KEY = "fincode_webhook_signature"

CONSUMER_BINDINGS = {
    "session_token_secret": (
        ("ReadingRequestFunction", "SESSION_TOKEN_SECRET"),
        ("ReadingStatusFunction", "SESSION_TOKEN_SECRET"),
    ),
    "audit_hash_secret": (
        ("ReadingRequestFunction", "AUDIT_HASH_SECRET"),
        ("ReadingStatusFunction", "AUDIT_HASH_SECRET"),
        ("LightWorkerFunction", "AUDIT_HASH_SECRET"),
        ("DeepWorkerFunction", "AUDIT_HASH_SECRET"),
    ),
    "reading_idempotency_hash_secret": (
        ("ReadingRequestFunction", "READING_IDEMPOTENCY_HASH_SECRET"),
        ("LightWorkerFunction", "READING_IDEMPOTENCY_HASH_SECRET"),
        ("DeepWorkerFunction", "READING_IDEMPOTENCY_HASH_SECRET"),
    ),
    "reading_deep_quota_hash_secret": (
        ("ReadingRequestFunction", "READING_DEEP_QUOTA_HASH_SECRET"),
        ("DeepWorkerFunction", "READING_DEEP_QUOTA_HASH_SECRET"),
    ),
}

SECRET_ARN = re.compile(
    r"^arn:aws:secretsmanager:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):secret:(?P<name>[A-Za-z0-9/_+=.@-]+)$"
)


class RuntimeSecretContractError(RuntimeError):
    """Raised when the staging secret repair boundary cannot be proven."""


def resolve_canonical_values(
    function_environments: Mapping[str, Mapping[str, object]],
) -> dict[str, str]:
    """Resolve canonical values only when every deployed consumer agrees."""

    resolved: dict[str, str] = {}
    for canonical_key, bindings in CONSUMER_BINDINGS.items():
        values: list[str] = []
        for logical_id, environment_key in bindings:
            environment = function_environments.get(logical_id)
            if not isinstance(environment, Mapping):
                raise RuntimeSecretContractError("required consumer is unavailable")
            value = environment.get(environment_key)
            if not isinstance(value, str) or value == "":
                raise RuntimeSecretContractError("required consumer value is unavailable")
            values.append(value)
        first = values[0]
        if any(value != first for value in values[1:]):
            raise RuntimeSecretContractError("consumer values do not match")
        resolved[canonical_key] = first
    return resolved


def merge_runtime_secret(
    existing: object, canonical_values: Mapping[str, object]
) -> dict[str, object]:
    """Merge canonical keys without deleting any existing JSON member."""

    if not isinstance(existing, dict):
        raise RuntimeSecretContractError("runtime secret must be a JSON object")
    if set(canonical_values) != set(CANONICAL_KEYS):
        raise RuntimeSecretContractError("canonical key set is incomplete")
    merged: dict[str, object] = dict(existing)
    for key in CANONICAL_KEYS:
        value = canonical_values[key]
        if not isinstance(value, str) or value == "":
            raise RuntimeSecretContractError("canonical value is unavailable")
        merged[key] = value
    if any(key not in merged for key in existing):
        raise RuntimeSecretContractError("merge removed an existing key")
    return merged


def assert_secret_boundary(
    runtime_secret_arn: str,
    webhook_secret_arn: str,
    expected_account: str,
) -> None:
    """Require two distinct staging Secrets in the exact account and region."""

    if runtime_secret_arn == webhook_secret_arn:
        raise RuntimeSecretContractError("runtime and webhook Secrets must differ")
    parsed = []
    for arn in (runtime_secret_arn, webhook_secret_arn):
        match = SECRET_ARN.fullmatch(arn)
        if match is None:
            raise RuntimeSecretContractError("secret ARN is invalid")
        if match.group("region") != REGION or match.group("account") != expected_account:
            raise RuntimeSecretContractError("secret boundary does not match")
        name = match.group("name").lower()
        if "prod" in name or "production" in name:
            raise RuntimeSecretContractError("secret is not staging scoped")
        parsed.append(name)
    runtime_name, webhook_name = parsed
    if any(token in runtime_name for token in ("fincode", "webhook", "signature")):
        raise RuntimeSecretContractError("runtime secret identity is ambiguous")
    if "fincode" not in webhook_name or not any(
        token in webhook_name for token in ("webhook", "signature")
    ):
        raise RuntimeSecretContractError("webhook secret identity is ambiguous")


def canonical_keys_present(secret_json: object) -> bool:
    """Return presence only; do not inspect or report secret metadata."""

    return isinstance(secret_json, dict) and all(
        isinstance(secret_json.get(key), str) and secret_json.get(key) != ""
        for key in CANONICAL_KEYS
    )


def extract_webhook_signature(secret_value: object) -> tuple[str, str]:
    """Mirror the deployed adapter contract without reporting the value."""

    if isinstance(secret_value, str):
        if not secret_value or len(secret_value) > 4096 or any(char in secret_value for char in ("\r", "\n", "\0")):
            raise RuntimeSecretContractError("webhook signature contract is invalid")
        return secret_value, "RAW_STRING"
    if (
        isinstance(secret_value, dict)
        and set(secret_value) == {WEBHOOK_SIGNATURE_KEY}
        and isinstance(secret_value.get(WEBHOOK_SIGNATURE_KEY), str)
    ):
        signature = secret_value[WEBHOOK_SIGNATURE_KEY]
        if not signature or len(signature) > 4096 or any(char in signature for char in ("\r", "\n", "\0")):
            raise RuntimeSecretContractError("webhook signature contract is invalid")
        return signature, "JSON_EXPECTED_KEY_PRESENT"
    raise RuntimeSecretContractError("webhook signature contract is invalid")


def normalized_webhook_secret(signature: object) -> dict[str, str]:
    """Create the exact one-key JSON form accepted by the deployed adapter."""

    value, _ = extract_webhook_signature(signature)
    return {WEBHOOK_SIGNATURE_KEY: value}
