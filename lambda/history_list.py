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
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")

TABLE_NAME = os.environ.get("TABLE_NAME", "shirone7_history")
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


def normalize_item(item):
    result = item.get("result") if isinstance(item.get("result"), dict) else {}
    preview_text = (
        item.get("summary")
        or item.get("result_preview")
        or result.get("summary")
        or item.get("result_text")
        or "鑑定結果を確認できます。"
    )

    return decimal_to_native({
        "history_id": item.get("history_id") or item.get("id", ""),
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
        "status": item.get("status", ""),
        "title": item.get("title", ""),
        "tier": item.get("tier", ""),
        "plan": item.get("plan", ""),
        "summary": preview_text,
    })


def query_history_items(user_id):
    items = []
    query_params = {
        "KeyConditionExpression": Key("user_id").eq(user_id),
    }

    while True:
        result = table.query(**query_params)
        items.extend(result.get("Items", []))

        last_key = result.get("LastEvaluatedKey")
        if not last_key:
            break

        query_params["ExclusiveStartKey"] = last_key

    return [normalize_item(item) for item in items]


def lambda_handler(event, context):
    logger.info("history list request started")

    if get_method(event) == "OPTIONS":
        return response(200, {"ok": True})

    try:
        try:
            payload = verify_session_token(event)
        except PermissionError:
            logger.info("history list unauthorized")
            return unauthorized_response()
        except RuntimeError:
            logger.error("history list configuration error")
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        user_id = payload["user_id"]
        items = query_history_items(user_id)

        logger.info("history list item count=%s", len(items))

        return response(200, {
            "items": items,
        })

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error("ClientError: %s", error_code)

        return response(500, {
            "ok": False,
            "message": "履歴一覧の取得に失敗しました",
        })

    except Exception as e:
        logger.error("ERROR: %s", type(e).__name__)

        return response(500, {
            "ok": False,
            "message": "履歴一覧の取得に失敗しました",
        })
