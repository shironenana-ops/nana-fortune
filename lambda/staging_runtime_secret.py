"""In-memory-only staging runtime Secret adapter."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re

import boto3


STAGING_SECRET_ARN = re.compile(
    r"^arn:aws:secretsmanager:ap-northeast-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$"
)
_cached_secret = None


class StagingRuntimeSecretUnavailable(Exception):
    pass


def load_staging_runtime_secret():
    global _cached_secret
    if _cached_secret is not None:
        return _cached_secret
    if os.environ.get("STAGING_ENVIRONMENT") != "staging" or os.environ.get("AWS_REGION") != "ap-northeast-1":
        raise StagingRuntimeSecretUnavailable("staging boundary is unavailable")
    arn = os.environ.get("RUNTIME_SECRETS_ARN", "")
    if not STAGING_SECRET_ARN.fullmatch(arn) or "prod" in arn.lower():
        raise StagingRuntimeSecretUnavailable("runtime secret binding is unavailable")
    try:
        result = boto3.client("secretsmanager", region_name="ap-northeast-1").get_secret_value(SecretId=arn)
        value = json.loads(result.get("SecretString", ""))
    except Exception as error:
        raise StagingRuntimeSecretUnavailable("runtime secret is unavailable") from error
    session_secret = value.get("session_token_secret") if isinstance(value, dict) else None
    if not isinstance(session_secret, str) or len(session_secret.encode("utf-8")) < 32:
        raise StagingRuntimeSecretUnavailable("runtime secret contract is unavailable")
    _cached_secret = {"session_token_secret": session_secret}
    return _cached_secret


def derive_auth_attempt_secret(session_secret: str) -> str:
    return hmac.new(
        session_secret.encode("utf-8"),
        b"shirone-staging-auth-attempt-v1",
        hashlib.sha256,
    ).hexdigest()
