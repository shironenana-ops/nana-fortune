"""Staging-only login Lambda using the existing password and session contracts."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from auth_security import (
    AuthAttemptLimiter,
    AuthSecurityConfig,
    AuthSecurityUnavailable,
    normalize_email,
    normalize_password,
    password_hash,
    password_matches,
    source_ip_from_event,
    validate_password,
)
from session_token import create_session_token
from staging_auth_common import (
    StagingAuthError,
    allowed_origins,
    enabled,
    http_response,
    parse_json_body,
    request_origin,
    require_staging,
    require_staging_table_name,
    safe_failure,
    valid_email,
    validate_route,
)
from staging_runtime_secret import derive_auth_attempt_secret, load_staging_runtime_secret


@dataclass
class LoginDependencies:
    users_table: object
    security_table: object
    session_secret: str


def _positive_integer(name: str, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "")
    if not raw.isascii() or not raw.isdigit():
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    value = int(raw)
    if value < minimum or value > maximum:
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    return value


def _dependencies() -> LoginDependencies:
    users_table_name = require_staging_table_name(os.environ.get("USERS_TABLE_NAME", ""))
    security_table_name = require_staging_table_name(os.environ.get("AUTH_SECURITY_TABLE_NAME", ""))
    if not users_table_name or not security_table_name or users_table_name == security_table_name:
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    secret = load_staging_runtime_secret()["session_token_secret"]
    dynamodb = boto3.resource("dynamodb", region_name="ap-northeast-1")
    return LoginDependencies(
        users_table=dynamodb.Table(users_table_name),
        security_table=dynamodb.Table(security_table_name),
        session_secret=secret,
    )


def _limiter(dependencies: LoginDependencies) -> AuthAttemptLimiter:
    if os.environ.get("AUTH_SECURITY_ENABLED") != "true":
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    config = AuthSecurityConfig(
        table_name=os.environ.get("AUTH_SECURITY_TABLE_NAME", ""),
        hash_secret=derive_auth_attempt_secret(dependencies.session_secret),
        account_failure_limit=_positive_integer("AUTH_ACCOUNT_FAILURE_LIMIT", 1, 20),
        account_window_seconds=_positive_integer("AUTH_ACCOUNT_WINDOW_SECONDS", 60, 86400),
        account_lock_seconds=_positive_integer("AUTH_ACCOUNT_LOCK_SECONDS", 60, 86400),
        ip_failure_limit=_positive_integer("AUTH_IP_FAILURE_LIMIT", 1, 100),
        ip_window_seconds=_positive_integer("AUTH_IP_WINDOW_SECONDS", 60, 86400),
    )
    return AuthAttemptLimiter(dependencies.security_table, config)


def _migrate_legacy(users_table, email: str, old_hash: str, password: str) -> None:
    try:
        users_table.update_item(
            Key={"user_id": email},
            UpdateExpression="SET #password = :password, updated_at = :now",
            ConditionExpression="#password = :old_password",
            ExpressionAttributeNames={"#password": "password"},
            ExpressionAttributeValues={
                ":password": password_hash(password),
                ":old_password": old_hash,
                ":now": datetime.now(timezone.utc).isoformat(),
            },
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


def lambda_handler(event, context, dependencies: LoginDependencies | None = None):
    origin = None
    try:
        require_staging(os.environ)
        origins = allowed_origins(os.environ)
        method = validate_route(event, "POST", "/login")
        origin = request_origin(event, origins)
        if method == "OPTIONS":
            return http_response(204, {}, origin)
        if not enabled(os.environ, "STAGING_LOGIN_ENABLED"):
            raise StagingAuthError(503, "STAGING_LOGIN_DISABLED", "login is not available")

        body = parse_json_body(event)
        email = normalize_email(body.get("email"))
        password = normalize_password(body.get("password"))
        if not valid_email(email) or not validate_password(password):
            raise StagingAuthError(400, "AUTH_INPUT_INVALID", "authentication data is invalid")

        runtime = dependencies or _dependencies()
        limiter = _limiter(runtime)
        try:
            retry_after = limiter.check(account=email, source_ip=source_ip_from_event(event))
        except AuthSecurityUnavailable as error:
            raise StagingAuthError(503, "AUTH_SECURITY_UNAVAILABLE", "temporarily unavailable") from error
        if retry_after is not None:
            return http_response(
                429,
                {"ok": False, "error": {"code": "AUTH_RATE_LIMITED", "message": "temporarily unavailable"}},
                origin,
                {"Retry-After": str(max(1, int(retry_after)))},
            )

        user = runtime.users_table.get_item(Key={"user_id": email}).get("Item")
        verification = password_matches(password, user.get("password") if user else None)
        if not user or not verification.accepted:
            try:
                retry_after = limiter.record_failure(account=email, source_ip=source_ip_from_event(event))
            except AuthSecurityUnavailable as error:
                raise StagingAuthError(503, "AUTH_SECURITY_UNAVAILABLE", "temporarily unavailable") from error
            if retry_after is not None:
                return http_response(
                    429,
                    {"ok": False, "error": {"code": "AUTH_RATE_LIMITED", "message": "temporarily unavailable"}},
                    origin,
                    {"Retry-After": str(max(1, int(retry_after)))},
                )
            raise StagingAuthError(401, "AUTH_INVALID", "email or password is invalid")

        if user.get("email_verified") is False:
            raise StagingAuthError(403, "AUTH_NOT_VERIFIED", "authentication is not available")
        if verification.legacy:
            _migrate_legacy(runtime.users_table, email, user.get("password"), password)
        try:
            limiter.record_success(account=email)
        except AuthSecurityUnavailable as error:
            raise StagingAuthError(503, "AUTH_SECURITY_UNAVAILABLE", "temporarily unavailable") from error

        token = create_session_token(email, secret=runtime.session_secret)
        now_iso = datetime.now(timezone.utc).isoformat()
        runtime.users_table.update_item(
            Key={"user_id": email},
            UpdateExpression="SET last_login_at = :now, updated_at = :now",
            ExpressionAttributeValues={":now": now_iso},
        )
        return http_response(
            200,
            {"ok": True, "token": token, "user_id": email},
            origin,
        )
    except Exception as error:
        return safe_failure(error, origin)
