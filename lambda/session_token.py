"""Pure session-token signing shared by login and staging-only tooling."""

import base64
import hashlib
import hmac
import json
import os
import time


SESSION_TTL_SECONDS = 60 * 60 * 24


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def create_session_token(user_id: str, *, secret: str | None = None, now: int | None = None) -> str:
    """Create the existing two-segment token without logging or persistence."""
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("user_id is required")
    actual_secret = secret if secret is not None else os.environ.get("SESSION_TOKEN_SECRET")
    if not isinstance(actual_secret, str) or not actual_secret:
        raise RuntimeError("SESSION_TOKEN_SECRET is not configured")
    issued_at = int(time.time()) if now is None else int(now)
    payload = {"user_id": user_id, "iat": issued_at, "exp": issued_at + SESSION_TTL_SECONDS}
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_part = _b64url_encode(payload_json)
    signature = hmac.new(actual_secret.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload_part}.{_b64url_encode(signature)}"
