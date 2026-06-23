import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")

TABLE_NAME = os.environ.get("TABLE_NAME", "shirone7_history")
table = dynamodb.Table(TABLE_NAME)

SAVE_FIELDS = [
    "history_id",
    "type",
    "source",
    "dedupe_key",
    "title",
    "input_title",
    "name",
    "birth_date",
    "gender",
    "category",
    "status",
    "created_at",
    "updated_at",
    "result_preview",
    "summary",
    "result_text",
    "result",
]


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
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


def safe_str(value):
    if value is None:
        return ""
    return str(value).strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


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


def parse_body(event):
    if event.get("isBase64Encoded"):
        raise ValueError("json body is required")

    body = event.get("body")
    if body is None:
        return {}

    if isinstance(body, dict):
        return body

    if not isinstance(body, str):
        raise ValueError("json body is required")

    try:
        parsed = json.loads(body, parse_float=Decimal)
    except json.JSONDecodeError:
        raise ValueError("json body is required")

    if not isinstance(parsed, dict):
        raise ValueError("json body is required")

    return parsed


def build_history_item(body, user_id):
    history_id = safe_str(body.get("history_id"))
    if not history_id:
        return None

    timestamp = now_iso()
    item = {
        "user_id": user_id,
        "history_id": history_id,
    }

    for field in SAVE_FIELDS:
        if field in body and field != "history_id":
            item[field] = body[field]

    item["history_id"] = history_id

    if not safe_str(item.get("created_at")):
        item["created_at"] = timestamp

    if not safe_str(item.get("updated_at")):
        item["updated_at"] = timestamp

    return item


def lambda_handler(event, context):
    logger.info("history save request started")

    if get_method(event) == "OPTIONS":
        return response(200, {"ok": True})

    try:
        try:
            payload = verify_session_token(event)
        except PermissionError:
            logger.info("history save unauthorized")
            return unauthorized_response()
        except RuntimeError:
            logger.error("history save configuration error")
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        try:
            body = parse_body(event)
        except ValueError:
            return response(400, {
                "ok": False,
                "message": "json body is required",
            })

        item = build_history_item(body, payload["user_id"])
        if not item:
            return response(400, {
                "ok": False,
                "message": "history_id is required",
            })

        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(user_id) AND attribute_not_exists(history_id)",
        )

        logger.info("history save completed")

        return response(201, {
            "ok": True,
            "message": "履歴を保存しました",
            "user_id": item["user_id"],
            "history_id": item["history_id"],
        })

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error("ClientError: %s", error_code)

        if error_code == "ConditionalCheckFailedException":
            return response(409, {
                "ok": False,
                "message": "履歴はすでに保存されています",
            })

        return response(500, {
            "ok": False,
            "message": "履歴の保存に失敗しました",
        })

    except Exception:
        logger.error("ERROR: history save failed")

        return response(500, {
            "ok": False,
            "message": "履歴の保存に失敗しました",
        })
