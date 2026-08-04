"""Staging-only signup Lambda using the existing password storage contract."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from auth_security import normalize_email, normalize_password, password_hash, validate_password
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


@dataclass
class SignupDependencies:
    users_table: object


def _dependencies() -> SignupDependencies:
    table_name = require_staging_table_name(os.environ.get("USERS_TABLE_NAME", ""))
    return SignupDependencies(
        users_table=boto3.resource("dynamodb", region_name="ap-northeast-1").Table(table_name)
    )


def lambda_handler(event, context, dependencies: SignupDependencies | None = None):
    origin = None
    try:
        require_staging(os.environ)
        origins = allowed_origins(os.environ)
        method = validate_route(event, "POST", "/signup")
        origin = request_origin(event, origins)
        if method == "OPTIONS":
            return http_response(204, {}, origin)
        if not enabled(os.environ, "STAGING_SIGNUP_ENABLED"):
            raise StagingAuthError(503, "STAGING_SIGNUP_DISABLED", "signup is not available")
        if os.environ.get("EMAIL_VERIFICATION_ENABLED") != "false":
            raise StagingAuthError(503, "STAGING_EMAIL_VERIFICATION_INVALID", "temporarily unavailable")

        body = parse_json_body(event)
        email = normalize_email(body.get("email"))
        password = normalize_password(body.get("password"))
        if not valid_email(email, staging_test_only=True) or not validate_password(password):
            raise StagingAuthError(400, "SIGNUP_INPUT_INVALID", "registration data is invalid")

        now_iso = datetime.now(timezone.utc).isoformat()
        item = {
            "user_id": email,
            "password": password_hash(password),
            "plan": "free",
            "subscription_status": "inactive",
            "deep_enabled": False,
            "monthly_voice_limit": 0,
            "monthly_voice_used": 0,
            "extra_voice_remaining": 0,
            "cancel_at_period_end": False,
            "current_period_start": None,
            "current_period_end": None,
            "membership_version": 1,
            "membership_schema_version": "shirone-membership-v1",
            "membership_source": "manual",
            "membership_updated_at": now_iso,
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        runtime = dependencies or _dependencies()
        try:
            runtime.users_table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(user_id)",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return http_response(
                    200,
                    {"ok": True, "message": "If registration can be completed, login will be available."},
                    origin,
                )
            raise
        return http_response(
            200,
            {"ok": True, "message": "If registration can be completed, login will be available."},
            origin,
        )
    except Exception as error:
        return safe_failure(error, origin)
