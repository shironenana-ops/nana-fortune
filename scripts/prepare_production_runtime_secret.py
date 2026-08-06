"""Recover the production runtime secret without exposing secret material.

The command is preflight-only unless --apply is supplied. It copies the existing
session-token secret from matching deployed consumers and generates independent
hash secrets only when the canonical secret does not already contain them.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from typing import Any

REGION = "ap-northeast-1"
SECRET_NAME = "shirone7/production/runtime"
SESSION_CONSUMERS = (
    "shirone7-login",
    "shirone7-history-save",
    "shirone7-history-list",
    "shirone7-history-detail",
    "shirone7-voice-upload",
)
CANONICAL_KEYS = (
    "session_token_secret",
    "audit_hash_secret",
    "reading_idempotency_hash_secret",
    "reading_deep_quota_hash_secret",
)
SAFE_CODES = {
    "SECRET_JSON_INVALID",
    "SESSION_SECRET_CONFLICT",
    "SESSION_SECRET_MISSING",
    "CANONICAL_SECRET_INVALID",
    "PRODUCTION_BOUNDARY_INVALID",
}


def parse_secret_json(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("SECRET_JSON_INVALID")
    return parsed


def merge_canonical_keys(current: dict[str, Any], session_secret: str) -> dict[str, Any]:
    merged = dict(current)
    existing_session = merged.get("session_token_secret")
    if existing_session is not None and existing_session != session_secret:
        raise ValueError("SESSION_SECRET_CONFLICT")
    merged["session_token_secret"] = session_secret
    for name in CANONICAL_KEYS[1:]:
        existing = merged.get(name)
        if existing is None:
            merged[name] = secrets.token_urlsafe(48)
        elif not isinstance(existing, str) or len(existing) < 32:
            raise ValueError("CANONICAL_SECRET_INVALID")
    return merged


def validate_args(args: argparse.Namespace) -> None:
    if not args.profile or not args.expected_account.isdigit() or len(args.expected_account) != 12:
        raise ValueError("PRODUCTION_BOUNDARY_INVALID")
    if args.region != REGION or args.secret_name != SECRET_NAME or "staging" in args.secret_name.lower():
        raise ValueError("PRODUCTION_BOUNDARY_INVALID")


def run(args: argparse.Namespace) -> dict[str, Any]:
    validate_args(args)
    import boto3  # imported only for the explicit CLI execution path
    from botocore.exceptions import ClientError

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    sts = session.client("sts")
    identity = sts.get_caller_identity()
    if identity.get("Account") != args.expected_account or ":assumed-role/" not in str(identity.get("Arn", "")):
        raise ValueError("PRODUCTION_BOUNDARY_INVALID")

    lambdas = session.client("lambda")
    observed: list[str] = []
    for function_name in SESSION_CONSUMERS:
        configuration = lambdas.get_function_configuration(FunctionName=function_name)
        value = ((configuration.get("Environment") or {}).get("Variables") or {}).get("SESSION_TOKEN_SECRET")
        if not isinstance(value, str) or len(value) < 32:
            raise ValueError("SESSION_SECRET_MISSING")
        observed.append(value)
    if any(value != observed[0] for value in observed[1:]):
        raise ValueError("SESSION_SECRET_CONFLICT")
    session_secret = observed[0]

    secret_client = session.client("secretsmanager")
    exists = True
    current: dict[str, Any] = {}
    try:
        metadata = secret_client.describe_secret(SecretId=args.secret_name)
        if metadata.get("Name") != args.secret_name or metadata.get("DeletedDate") is not None:
            raise ValueError("PRODUCTION_BOUNDARY_INVALID")
        if args.apply:
            payload = secret_client.get_secret_value(SecretId=args.secret_name)
            secret_string = payload.get("SecretString")
            if not isinstance(secret_string, str):
                raise ValueError("SECRET_JSON_INVALID")
            current = parse_secret_json(secret_string)
    except ClientError as error:
        code = ((error.response or {}).get("Error") or {}).get("Code")
        if code != "ResourceNotFoundException":
            raise
        exists = False

    if not args.apply:
        return {
            "environment": "production",
            "mode": "preflight",
            "session_consumers_checked": len(SESSION_CONSUMERS),
            "session_consumers_match": True,
            "runtime_secret_exists": exists,
            "aws_mutations": 0,
        }

    merged = merge_canonical_keys(current, session_secret)
    payload = json.dumps(merged, separators=(",", ":"), ensure_ascii=True)
    if exists:
        secret_client.put_secret_value(SecretId=args.secret_name, SecretString=payload)
        operation = "MERGED_NEW_VERSION"
    else:
        secret_client.create_secret(
            Name=args.secret_name,
            SecretString=payload,
            Description="Canonical nana-fortune production runtime secrets",
            Tags=[
                {"Key": "Project", "Value": "nana-fortune"},
                {"Key": "Environment", "Value": "production"},
                {"Key": "Component", "Value": "canonical-runtime"},
            ],
        )
        operation = "CREATED"
    verify = secret_client.get_secret_value(SecretId=args.secret_name)
    verify_string = verify.get("SecretString")
    verified = parse_secret_json(verify_string) if isinstance(verify_string, str) else {}
    if any(not isinstance(verified.get(name), str) or len(verified[name]) < 32 for name in CANONICAL_KEYS):
        raise ValueError("CANONICAL_SECRET_INVALID")
    return {
        "environment": "production",
        "mode": "apply",
        "operation": operation,
        "session_consumers_checked": len(SESSION_CONSUMERS),
        "session_consumers_match": True,
        "canonical_keys_present": len(CANONICAL_KEYS),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--region", default=REGION)
    parser.add_argument("--secret-name", default=SECRET_NAME)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        result = run(args)
    except Exception as error:  # no provider message or secret material is emitted
        safe_code = str(error) if isinstance(error, ValueError) and str(error) in SAFE_CODES else "PRODUCTION_RUNTIME_SECRET_FAILED"
        sys.stdout.write(json.dumps({"status": "BLOCKED", "safe_code": safe_code}, separators=(",", ":")) + "\n")
        return 1
    sys.stdout.write(json.dumps({"status": "PASS", **result}, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
