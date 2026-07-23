"""Non-enumerating email verification resend endpoint."""

import json
import os

import boto3

from auth_security import AuthSecurityError, normalize_email, now_epoch, read_email_verification_config
from email_verification import issue_verification


dynamodb = boto3.resource("dynamodb")
users_table = dynamodb.Table(os.environ.get("TABLE_NAME", "shirone7_users"))


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
            "Content-Type": "application/json; charset=utf-8",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def generic_response():
    return response(200, {"ok": True, "message": "If eligible, a verification email will be sent."})


def lambda_handler(event, context):
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or ""
    ).upper()
    if method == "OPTIONS":
        return response(200, {"ok": True})
    if method != "POST":
        return response(405, {"ok": False, "message": "method not allowed"})
    try:
        body = event.get("body")
        body = json.loads(body) if isinstance(body, str) else (body or {})
        email = normalize_email(body.get("email"))
        config = read_email_verification_config()
        if not config or not email or "@" not in email:
            return generic_response()
        user = users_table.get_item(Key={"user_id": email}).get("Item")
        if not user or user.get("email_verified") is not False:
            return generic_response()
        if int(user.get("email_verification_resend_at", 0) or 0) > now_epoch():
            return generic_response()
        issue_verification(
            users_table=users_table,
            security_table=dynamodb.Table(config.table_name),
            email=email,
            config=config,
        )
    except AuthSecurityError:
        return response(503, {"ok": False, "message": "temporarily unavailable"})
    except Exception:
        # Preserve non-enumeration for existing/absent/verified accounts.
        return generic_response()
    return generic_response()
