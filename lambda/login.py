import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE_NAME = os.environ.get("TABLE_NAME", "shirone7_users")
SESSION_TTL_SECONDS = 60 * 60 * 24

table = dynamodb.Table(TABLE_NAME)


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
            "Content-Type": "application/json; charset=utf-8",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def parse_body(event):
    body = event.get("body")

    if body is None:
        return {}

    if isinstance(body, dict):
        return body

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {}

    return parsed if isinstance(parsed, dict) else {}


def get_method(event):
    return (
        event.get("requestContext", {})
        .get("http", {})
        .get("method")
        or event.get("httpMethod")
        or ""
    ).upper()


def get_session_secret():
    secret = os.environ.get("SESSION_TOKEN_SECRET")
    if not secret:
        raise RuntimeError("SESSION_TOKEN_SECRET is not configured")
    return secret


def b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def create_session_token(user_id):
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("user_id is required")

    secret = get_session_secret()
    now = int(time.time())

    payload = {
        "user_id": user_id,
        "iat": now,
        "exp": now + SESSION_TTL_SECONDS,
    }

    payload_json = json.dumps(
        payload,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    payload_part = b64url_encode(payload_json)

    signature = hmac.new(
        secret.encode("utf-8"),
        payload_part.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    signature_part = b64url_encode(signature)

    return f"{payload_part}.{signature_part}"


def normalize_email(value):
    if not isinstance(value, str):
        return ""
    return value.strip().lower()


def normalize_password(value):
    if not isinstance(value, str):
        return ""
    return value.strip()


def is_valid_email(email):
    return bool(email) and "@" in email and len(email) <= 254


def password_hash(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def password_matches(password, stored_password_hash):
    if not isinstance(stored_password_hash, str) or not stored_password_hash:
        return False

    candidate_hash = password_hash(password)
    return hmac.compare_digest(candidate_hash, stored_password_hash)


def to_bool(value, default=False):
    if value is None:
        return default
    return bool(value)


def to_int(value, default=0):
    if value is None or value == "":
        return default

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def build_success_body(email, user, token):
    return {
        "ok": True,
        "message": "ログインしました。",
        "token": token,
        "user_id": email,
        "email": email,
        "plan": user.get("plan", "free"),
        "subscription_status": user.get("subscription_status", "inactive"),
        "deep_enabled": to_bool(user.get("deep_enabled"), False),
        "monthly_voice_limit": to_int(user.get("monthly_voice_limit"), 0),
        "monthly_voice_used": to_int(user.get("monthly_voice_used"), 0),
        "extra_voice_remaining": to_int(user.get("extra_voice_remaining"), 0),
        "current_period_end": user.get("current_period_end", ""),
    }


def lambda_handler(event, context):
    if get_method(event) == "OPTIONS":
        return response(200, {"ok": True})

    try:
        body = parse_body(event)

        email = normalize_email(body.get("email"))
        password = normalize_password(body.get("password"))

        if not is_valid_email(email):
            return response(400, {
                "ok": False,
                "message": "email is invalid",
            })

        if not password:
            return response(400, {
                "ok": False,
                "message": "password is required",
            })

        result = table.get_item(Key={"user_id": email})
        user = result.get("Item")

        if not user:
            return response(401, {
                "ok": False,
                "message": "email or password is invalid",
            })

        if not password_matches(password, user.get("password")):
            return response(401, {
                "ok": False,
                "message": "email or password is invalid",
            })

        try:
            token = create_session_token(email)
        except RuntimeError:
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        now_iso = datetime.now(timezone.utc).isoformat()
        table.update_item(
            Key={"user_id": email},
            UpdateExpression="SET last_login_at = :now, updated_at = :now",
            ExpressionAttributeValues={
                ":now": now_iso,
            },
        )

        return response(200, build_success_body(email, user, token))

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        print("ClientError:", error_code)

        return response(500, {
            "ok": False,
            "message": "login failed",
        })

    except Exception as e:
        print("ERROR:", type(e).__name__)

        return response(500, {
            "ok": False,
            "message": "login failed",
        })
