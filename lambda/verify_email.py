"""Single-use email verification endpoint.  It accepts only an opaque token."""

import json
import os

import boto3

from auth_security import AuthSecurityError, parse_verification_token, read_email_verification_config
from email_verification import verify_verification_token


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
        config = read_email_verification_config()
        if not config:
            return response(404, {"ok": False, "message": "not available"})
        token = parse_verification_token(body.get("token"), config)
        verified = verify_verification_token(
            users_table=users_table,
            security_table=dynamodb.Table(config.table_name),
            token=token,
            config=config,
        )
    except AuthSecurityError:
        verified = False
    except Exception:
        return response(503, {"ok": False, "message": "temporarily unavailable"})
    if not verified:
        return response(400, {"ok": False, "message": "verification link is invalid or expired"})
    return response(200, {"ok": True, "message": "email verified"})
