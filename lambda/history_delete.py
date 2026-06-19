import base64
import binascii
import hashlib
import hmac
import json
import os
import time

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE_NAME = os.environ.get("HISTORY_TABLE_NAME", "shirone7_history")
table = dynamodb.Table(TABLE_NAME)


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "OPTIONS,POST",
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
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


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

    if len(token) > 4096:
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


def lambda_handler(event, context):
    method = (
        event.get("requestContext", {})
        .get("http", {})
        .get("method", "")
        .upper()
    )

    if method == "OPTIONS":
        return response(200, {"ok": True})

    try:
        try:
            payload = verify_session_token(event)
        except PermissionError:
            return unauthorized_response()
        except RuntimeError:
            return response(500, {
                "ok": False,
                "message": "server configuration error",
            })

        body = parse_body(event)

        history_id = body.get("history_id") if isinstance(body, dict) else None
        if not isinstance(history_id, str) or not history_id:
            return response(400, {
                "ok": False,
                "message": "history_id is required",
            })

        user_id = payload["user_id"]

        delete_result = table.delete_item(
            Key={
                "user_id": user_id,
                "history_id": history_id,
            },
            ConditionExpression="attribute_exists(user_id) AND attribute_exists(history_id)",
            ReturnValues="ALL_OLD",
        )

        deleted_item = delete_result.get("Attributes", {})

        return response(200, {
            "ok": True,
            "message": "履歴を削除しました",
            "deleted": {
                "user_id": deleted_item.get("user_id", user_id),
                "history_id": deleted_item.get("history_id", history_id),
                "title": deleted_item.get("title") or deleted_item.get("input_title") or "",
            },
        })

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")

        print("ClientError:", error_code)

        if error_code == "ConditionalCheckFailedException":
            return response(404, {
                "ok": False,
                "message": "削除対象の履歴が見つかりません",
            })

        return response(500, {
            "ok": False,
            "message": "履歴の削除に失敗しました",
        })

    except Exception as e:
        print("ERROR:", type(e).__name__)

        return response(500, {
            "ok": False,
            "message": "履歴の削除に失敗しました",
        })
