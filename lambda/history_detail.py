import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import time
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
s3 = boto3.client("s3")

TABLE_NAME = os.environ.get("HISTORY_TABLE", "shirone7_history")
DEFAULT_HISTORY_BUCKET = os.environ.get("HISTORY_BUCKET", "shirone7-voice-poc-001")
table = dynamodb.Table(TABLE_NAME)


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


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


def get_header(headers, name):
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value or ""
    return ""


def b64url_decode(value):
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def unauthorized_response():
    return response(401, {
        "ok": False,
        "message": "unauthorized",
    })


def verify_session_token(event):
    secret = get_session_secret()

    authorization = get_header(event.get("headers") or {}, "Authorization")
    if not authorization.startswith("Bearer "):
        raise PermissionError("unauthorized")

    token = authorization.replace("Bearer ", "", 1).strip()

    if not token or len(token) > 4096:
        raise PermissionError("unauthorized")

    if token.count(".") != 1:
        raise PermissionError("unauthorized")

    payload_part, signature_part = token.split(".", 1)

    try:
        expected_signature = hmac.new(
            secret.encode("utf-8"),
            payload_part.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        actual_signature = b64url_decode(signature_part)
    except (binascii.Error, ValueError):
        raise PermissionError("unauthorized")

    if not hmac.compare_digest(expected_signature, actual_signature):
        raise PermissionError("unauthorized")

    try:
        payload_raw = b64url_decode(payload_part)
        payload = json.loads(payload_raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise PermissionError("unauthorized")
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise PermissionError("unauthorized")

    user_id = payload.get("user_id")
    iat = payload.get("iat")
    exp = payload.get("exp")

    if not isinstance(user_id, str) or not user_id:
        raise PermissionError("unauthorized")

    if type(iat) is not int or type(exp) is not int:
        raise PermissionError("unauthorized")

    if exp < int(time.time()):
        raise PermissionError("unauthorized")

    return payload


def decimal_to_native(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)

    if isinstance(value, list):
        return [decimal_to_native(item) for item in value]

    if isinstance(value, dict):
        return {
            key: decimal_to_native(item)
            for key, item in value.items()
        }

    return value


def read_detail_json(item):
    history_s3_key = item.get("history_s3_key")
    if not history_s3_key:
        return {}

    history_bucket = item.get("history_bucket") or DEFAULT_HISTORY_BUCKET
    result = s3.get_object(
        Bucket=history_bucket,
        Key=history_s3_key,
    )
    raw_body = result["Body"].read().decode("utf-8")

    return decimal_to_native(json.loads(raw_body))


def lambda_handler(event, context):
    logger.info("history detail request started")

    if get_method(event) == "OPTIONS":
        return response(200, {"ok": True})

    try:
        try:
            payload = verify_session_token(event)
        except (PermissionError, RuntimeError):
            logger.info("history detail unauthorized")
            return unauthorized_response()

        params = event.get("queryStringParameters") or {}
        history_id = params.get("history_id") or params.get("id")
        if isinstance(history_id, str):
            history_id = history_id.strip()

        if not isinstance(history_id, str) or not history_id:
            return response(400, {
                "ok": False,
                "message": "history_id is required",
            })

        user_id = payload["user_id"]
        result = table.get_item(
            Key={
                "user_id": user_id,
                "history_id": history_id,
            }
        )
        item = result.get("Item")

        if not item:
            return response(404, {
                "ok": False,
                "message": "履歴が見つかりません",
            })

        detail = read_detail_json(item)

        logger.info("history detail found")

        return response(200, {
            "message": "履歴詳細を取得しました",
            "user_id": user_id,
            "history_id": history_id,
            "item": decimal_to_native(item),
            "detail": detail,
        })

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error("ClientError: %s", error_code)

        return response(500, {
            "ok": False,
            "message": "履歴詳細の取得に失敗しました",
        })

    except Exception:
        logger.error("ERROR: history detail failed")

        return response(500, {
            "ok": False,
            "message": "履歴詳細の取得に失敗しました",
        })
