"""Shared fail-closed HTTP and configuration helpers for staging auth Lambdas."""

from __future__ import annotations

import json
import os
import re
from typing import Mapping


LOCAL_STAGING_ORIGINS = frozenset(
    ("http://127.0.0.1:4321", "http://localhost:4321")
)
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+$")
STAGING_TABLE_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")


class StagingAuthError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message


def enabled(env: Mapping[str, str], name: str) -> bool:
    value = env.get(name)
    if value not in ("true", "false"):
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    return value == "true"


def require_staging(env: Mapping[str, str]) -> None:
    if env.get("STAGING_ENVIRONMENT") != "staging":
        raise StagingAuthError(503, "STAGING_BOUNDARY_INVALID", "temporarily unavailable")


def require_staging_table_name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not STAGING_TABLE_PATTERN.fullmatch(value)
        or "staging" not in value.lower()
        or "prod" in value.lower()
        or "production" in value.lower()
    ):
        raise StagingAuthError(503, "STAGING_AUTH_NOT_CONFIGURED", "temporarily unavailable")
    return value


def allowed_origins(env: Mapping[str, str]) -> frozenset[str]:
    raw = env.get("ALLOWED_ORIGINS", "")
    values = frozenset(value.strip() for value in raw.split(",") if value.strip())
    if values != LOCAL_STAGING_ORIGINS or "*" in values:
        raise StagingAuthError(503, "STAGING_CORS_NOT_CONFIGURED", "temporarily unavailable")
    return values


def event_method(event) -> str:
    if not isinstance(event, dict) or event.get("version") != "2.0":
        raise StagingAuthError(400, "HTTP_EVENT_INVALID", "request is invalid")
    context = event.get("requestContext")
    http = context.get("http") if isinstance(context, dict) else None
    method = http.get("method") if isinstance(http, dict) else None
    if not isinstance(method, str):
        raise StagingAuthError(400, "HTTP_EVENT_INVALID", "request is invalid")
    return method.upper()


def validate_route(event, expected_method: str, expected_path: str) -> str:
    method = event_method(event)
    if method not in (expected_method, "OPTIONS"):
        raise StagingAuthError(405, "HTTP_METHOD_NOT_ALLOWED", "method not allowed")
    expected = f"{method} {expected_path}"
    if event.get("routeKey") != expected:
        raise StagingAuthError(404, "HTTP_ROUTE_NOT_FOUND", "route not found")
    return method


def request_origin(event, origins: frozenset[str]) -> str | None:
    headers = event.get("headers") if isinstance(event, dict) else None
    if headers is None:
        return None
    if not isinstance(headers, dict):
        raise StagingAuthError(400, "HTTP_EVENT_INVALID", "request is invalid")
    found = []
    for name, value in headers.items():
        if not isinstance(name, str) or not isinstance(value, str) or "\r" in value or "\n" in value:
            raise StagingAuthError(400, "HTTP_EVENT_INVALID", "request is invalid")
        if name.lower() == "origin":
            found.append(value)
    if len(found) > 1:
        raise StagingAuthError(400, "HTTP_EVENT_INVALID", "request is invalid")
    if not found:
        return None
    if found[0] not in origins:
        raise StagingAuthError(403, "ORIGIN_NOT_ALLOWED", "origin is not allowed")
    return found[0]


def parse_json_body(event) -> dict:
    body = event.get("body") if isinstance(event, dict) else None
    if not isinstance(body, str) or len(body.encode("utf-8")) > 4096:
        raise StagingAuthError(400, "REQUEST_BODY_INVALID", "request is invalid")
    try:
        parsed = json.loads(body)
    except (TypeError, ValueError):
        raise StagingAuthError(400, "REQUEST_BODY_INVALID", "request is invalid")
    if not isinstance(parsed, dict):
        raise StagingAuthError(400, "REQUEST_BODY_INVALID", "request is invalid")
    return parsed


def valid_email(email: str, *, staging_test_only: bool = False) -> bool:
    if not isinstance(email, str) or not email or len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
        return False
    domain = email.rsplit("@", 1)[1].lower()
    return not staging_test_only or domain == "staging.invalid" or domain.endswith(".staging.invalid")


def http_response(status_code: int, body: dict, origin: str | None = None, extra_headers=None):
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Vary": "Origin",
    }
    if origin:
        headers.update(
            {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Headers": "authorization,content-type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Max-Age": "600",
            }
        )
    if extra_headers:
        headers.update(extra_headers)
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": "" if status_code == 204 else json.dumps(body, ensure_ascii=False),
        "isBase64Encoded": False,
    }


def safe_failure(error: Exception, origin: str | None = None):
    if isinstance(error, StagingAuthError):
        return http_response(
            error.status_code,
            {"ok": False, "error": {"code": error.code, "message": error.message}},
            origin,
        )
    return http_response(
        503,
        {"ok": False, "error": {"code": "STAGING_AUTH_UNAVAILABLE", "message": "temporarily unavailable"}},
        origin,
    )


def environment() -> Mapping[str, str]:
    return os.environ
