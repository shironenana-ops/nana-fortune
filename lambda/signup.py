"""Signup handler with versioned password storage and optional email verification."""

import json
import os

import boto3
from botocore.exceptions import ClientError

from auth_security import (
    AuthSecurityError,
    normalize_email,
    normalize_password,
    password_hash,
    read_email_verification_config,
    validate_password,
)
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


def parse_body(event):
    body = event.get("body") if isinstance(event, dict) else None
    if isinstance(body, dict):
        return body
    try:
        value = json.loads(body or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def get_method(event):
    return (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or ""
    ).upper()


def generic_signup_response(email_verification_required=False):
    return response(
        200,
        {
            "ok": True,
            "message": "If registration can be completed, the next step will be available shortly.",
            "email_verification_required": bool(email_verification_required),
        },
    )


def lambda_handler(event, context):
    if get_method(event) == "OPTIONS":
        return response(200, {"ok": True})
    if get_method(event) != "POST":
        return response(405, {"ok": False, "message": "method not allowed"})

    body = parse_body(event)
    email = normalize_email(body.get("email"))
    password = normalize_password(body.get("password"))
    if not email or "@" not in email or len(email) > 254 or not validate_password(password):
        return response(400, {"ok": False, "message": "registration data is invalid"})

    try:
        verification_config = read_email_verification_config()
    except AuthSecurityError:
        return response(503, {"ok": False, "message": "temporarily unavailable"})

    item = {
        "user_id": email,
        "password": password_hash(password),
        "plan": "free",
        "subscription_status": "inactive",
    }
    if verification_config:
        item["email_verified"] = False

    try:
        users_table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(user_id)",
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            # Do not reveal whether the address already has an account.
            return generic_signup_response(bool(verification_config))
        return response(503, {"ok": False, "message": "temporarily unavailable"})
    except Exception:
        return response(503, {"ok": False, "message": "temporarily unavailable"})

    if verification_config:
        try:
            issue_verification(
                users_table=users_table,
                security_table=dynamodb.Table(verification_config.table_name),
                email=email,
                config=verification_config,
            )
        except Exception:
            # Account remains pending, but no usable token is retained; resend
            # can retry once delivery configuration is healthy.
            return response(503, {"ok": False, "message": "temporarily unavailable"})

    return generic_signup_response(bool(verification_config))
