"""Shared authentication security primitives for the Python Lambda handlers.

This module intentionally has no AWS client side effects at import time.  Runtime
handlers provide DynamoDB tables and the SES adapter is created only when a
verification email is actually dispatched.
"""

import base64
import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping, Optional
from urllib.parse import quote


PASSWORD_SCHEME = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 600_000
MAX_PBKDF2_ITERATIONS = 2_000_000
PASSWORD_SALT_BYTES = 16
PASSWORD_DK_BYTES = 32
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_CHARACTERS = 128
MAX_PASSWORD_BYTES = 256
VERIFY_TOKEN_ID_BYTES = 16
VERIFY_TOKEN_SECRET_BYTES = 32
VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60
DEFAULT_RESEND_INTERVAL_SECONDS = 60


class AuthSecurityError(Exception):
    """A safe configuration or state failure for authentication controls."""


class AuthSecurityUnavailable(AuthSecurityError):
    """The enabled control cannot safely reach its shared state."""


@dataclass(frozen=True)
class PasswordVerification:
    accepted: bool
    legacy: bool


@dataclass(frozen=True)
class AuthSecurityConfig:
    table_name: str
    hash_secret: str
    account_failure_limit: int
    account_window_seconds: int
    account_lock_seconds: int
    ip_failure_limit: int
    ip_window_seconds: int


@dataclass(frozen=True)
class EmailVerificationConfig:
    table_name: str
    token_secret: str
    from_address: str
    base_url: str
    aws_region: str
    resend_interval_seconds: int
    token_ttl_seconds: int


@dataclass(frozen=True)
class VerificationToken:
    raw: str
    reference: str
    digest: str


def now_epoch() -> int:
    return int(time.time())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not value or "=" in value:
        raise ValueError("invalid base64url")
    padded = value + ("=" * (-len(value) % 4))
    decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    if b64url_encode(decoded) != value:
        raise ValueError("non-canonical base64url")
    return decoded


def normalize_email(value) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().lower()


def is_valid_email(email: str) -> bool:
    return bool(email) and "@" in email and len(email) <= 254 and "\x00" not in email


def normalize_password(value) -> str:
    # Preserve the legacy endpoint's whitespace behavior for existing users.
    return value.strip() if isinstance(value, str) else ""


def validate_password(password: str) -> bool:
    if not isinstance(password, str):
        return False
    try:
        byte_length = len(password.encode("utf-8"))
    except UnicodeEncodeError:
        return False
    return (
        MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_CHARACTERS
        and byte_length <= MAX_PASSWORD_BYTES
        and "\x00" not in password
    )


def password_hash(password: str, *, salt: Optional[bytes] = None, iterations: int = PBKDF2_ITERATIONS) -> str:
    if not validate_password(password):
        raise ValueError("invalid password")
    if not isinstance(iterations, int) or iterations < PBKDF2_ITERATIONS or iterations > MAX_PBKDF2_ITERATIONS:
        raise ValueError("invalid PBKDF2 iterations")
    actual_salt = salt if salt is not None else secrets.token_bytes(PASSWORD_SALT_BYTES)
    if not isinstance(actual_salt, bytes) or len(actual_salt) < PASSWORD_SALT_BYTES:
        raise ValueError("invalid password salt")
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        actual_salt,
        iterations,
        dklen=PASSWORD_DK_BYTES,
    )
    return "$".join((PASSWORD_SCHEME, str(iterations), b64url_encode(actual_salt), b64url_encode(derived)))


def _legacy_sha256_matches(password: str, stored: str) -> bool:
    if len(stored) != 64 or any(character not in "0123456789abcdefABCDEF" for character in stored):
        return False
    candidate = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(candidate, stored.lower())


def password_matches(password: str, stored_password_hash) -> PasswordVerification:
    """Verify a modern or legacy record without silently accepting malformed data."""
    if not validate_password(password) or not isinstance(stored_password_hash, str):
        return PasswordVerification(False, False)

    if stored_password_hash.startswith(f"{PASSWORD_SCHEME}$"):
        parts = stored_password_hash.split("$")
        if len(parts) != 4 or parts[0] != PASSWORD_SCHEME:
            return PasswordVerification(False, False)
        try:
            iterations = int(parts[1])
            salt = b64url_decode(parts[2])
            expected = b64url_decode(parts[3])
        except (TypeError, ValueError):
            return PasswordVerification(False, False)
        if (
            iterations < PBKDF2_ITERATIONS
            or iterations > MAX_PBKDF2_ITERATIONS
            or len(salt) < PASSWORD_SALT_BYTES
            or len(expected) != PASSWORD_DK_BYTES
        ):
            return PasswordVerification(False, False)
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations, dklen=PASSWORD_DK_BYTES
        )
        return PasswordVerification(hmac.compare_digest(candidate, expected), False)

    return PasswordVerification(_legacy_sha256_matches(password, stored_password_hash), True)


def hmac_reference(secret: str, domain: str, value: str) -> str:
    if not isinstance(secret, str) or not secret or not isinstance(value, str) or not value:
        raise AuthSecurityError("security reference configuration is invalid")
    message = f"shirone-auth-security-v1\0{domain}\0{value}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def feature_enabled(env: Mapping[str, str], name: str) -> bool:
    return env.get(name) == "true"


def _required_text(env: Mapping[str, str], name: str) -> str:
    value = env.get(name)
    if not isinstance(value, str) or not value.strip():
        raise AuthSecurityError(f"{name} is not configured")
    return value.strip()


def _required_integer(env: Mapping[str, str], name: str, minimum: int, maximum: int) -> int:
    raw = _required_text(env, name)
    if not raw.isascii() or not raw.isdigit():
        raise AuthSecurityError(f"{name} is invalid")
    value = int(raw)
    if value < minimum or value > maximum:
        raise AuthSecurityError(f"{name} is invalid")
    return value


def read_auth_security_config(env: Mapping[str, str] = os.environ) -> Optional[AuthSecurityConfig]:
    if not feature_enabled(env, "AUTH_SECURITY_ENABLED"):
        return None
    return AuthSecurityConfig(
        table_name=_required_text(env, "AUTH_SECURITY_TABLE_NAME"),
        hash_secret=_required_text(env, "AUTH_SECURITY_HASH_SECRET"),
        account_failure_limit=_required_integer(env, "AUTH_ACCOUNT_FAILURE_LIMIT", 1, 20),
        account_window_seconds=_required_integer(env, "AUTH_ACCOUNT_WINDOW_SECONDS", 60, 24 * 60 * 60),
        account_lock_seconds=_required_integer(env, "AUTH_ACCOUNT_LOCK_SECONDS", 60, 24 * 60 * 60),
        ip_failure_limit=_required_integer(env, "AUTH_IP_FAILURE_LIMIT", 1, 100),
        ip_window_seconds=_required_integer(env, "AUTH_IP_WINDOW_SECONDS", 60, 24 * 60 * 60),
    )


def read_email_verification_config(env: Mapping[str, str] = os.environ) -> Optional[EmailVerificationConfig]:
    if not feature_enabled(env, "EMAIL_VERIFICATION_ENABLED"):
        return None
    base_url = _required_text(env, "EMAIL_VERIFICATION_BASE_URL")
    if not base_url.startswith("https://") or "?" in base_url or "#" in base_url:
        raise AuthSecurityError("EMAIL_VERIFICATION_BASE_URL is invalid")
    return EmailVerificationConfig(
        table_name=_required_text(env, "AUTH_SECURITY_TABLE_NAME"),
        token_secret=_required_text(env, "EMAIL_VERIFICATION_TOKEN_SECRET"),
        from_address=_required_text(env, "EMAIL_VERIFICATION_FROM_ADDRESS"),
        base_url=base_url.rstrip("/"),
        aws_region=_required_text(env, "AWS_REGION"),
        resend_interval_seconds=_required_integer(
            env, "EMAIL_VERIFICATION_RESEND_SECONDS", 30, 24 * 60 * 60
        ),
        token_ttl_seconds=_required_integer(
            env, "EMAIL_VERIFICATION_TTL_SECONDS", 5 * 60, 7 * 24 * 60 * 60
        ),
    )


def create_verification_token(config: EmailVerificationConfig) -> VerificationToken:
    token_id = b64url_encode(secrets.token_bytes(VERIFY_TOKEN_ID_BYTES))
    token_secret = b64url_encode(secrets.token_bytes(VERIFY_TOKEN_SECRET_BYTES))
    raw = f"v1.{token_id}.{token_secret}"
    reference = hmac_reference(config.token_secret, "email-verification-reference", token_id)
    digest = hmac_reference(config.token_secret, "email-verification-digest", raw)
    return VerificationToken(raw=raw, reference=reference, digest=digest)


def parse_verification_token(raw: str, config: EmailVerificationConfig) -> VerificationToken:
    if not isinstance(raw, str):
        raise AuthSecurityError("verification token is invalid")
    parts = raw.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise AuthSecurityError("verification token is invalid")
    try:
        token_id = b64url_decode(parts[1])
        secret = b64url_decode(parts[2])
    except (TypeError, ValueError) as error:
        raise AuthSecurityError("verification token is invalid") from error
    if len(token_id) != VERIFY_TOKEN_ID_BYTES or len(secret) != VERIFY_TOKEN_SECRET_BYTES:
        raise AuthSecurityError("verification token is invalid")
    return VerificationToken(
        raw=raw,
        reference=hmac_reference(config.token_secret, "email-verification-reference", parts[1]),
        digest=hmac_reference(config.token_secret, "email-verification-digest", raw),
    )


def verification_url(config: EmailVerificationConfig, token: VerificationToken) -> str:
    return f"{config.base_url}/verify-email?token={quote(token.raw, safe='')}"


class SesV2EmailSender:
    """Lazy SES v2 adapter. Tests pass a fake sender instead."""

    def __init__(self, region_name: str):
        self.region_name = region_name

    def send_verification(self, *, config: EmailVerificationConfig, recipient: str, token: VerificationToken) -> None:
        # Import and client creation occur only in a deployed, enabled invocation.
        import boto3

        url = verification_url(config, token)
        client = boto3.client("sesv2", region_name=self.region_name)
        client.send_email(
            FromEmailAddress=config.from_address,
            Destination={"ToAddresses": [recipient]},
            Content={
                "Simple": {
                    "Subject": {"Data": "白音七 メールアドレス認証"},
                    "Body": {
                        "Text": {
                            "Data": (
                                "白音七の登録を完了するには、次のリンクを開いてください。\n"
                                f"{url}\n\n"
                                "このリンクは一定時間で失効します。"
                            )
                        }
                    },
                }
            },
        )


class AuthAttemptLimiter:
    """DynamoDB-backed shared login failure control without raw PII keys."""

    def __init__(self, table, config: AuthSecurityConfig, *, clock=now_epoch):
        self.table = table
        self.config = config
        self.clock = clock

    def _identity_ref(self, kind: str, value: str) -> str:
        return hmac_reference(self.config.hash_secret, kind, value)

    def _bucket(self, kind: str, raw_value: str, window_seconds: int, now: int):
        identity_ref = self._identity_ref(kind, raw_value)
        started_at = now - (now % window_seconds)
        bucket_ref = hmac_reference(self.config.hash_secret, f"{kind}-window", f"{identity_ref}:{started_at}")
        return identity_ref, bucket_ref, started_at

    def _get(self, reference: str):
        try:
            return self.table.get_item(Key={"security_ref": reference}).get("Item")
        except Exception as error:
            raise AuthSecurityUnavailable("auth security state unavailable") from error

    def _increment(self, *, kind: str, raw_value: str, limit: int, window_seconds: int, now: int):
        identity_ref, bucket_ref, started_at = self._bucket(kind, raw_value, window_seconds, now)
        expires_at = started_at + (window_seconds * 2)
        try:
            result = self.table.update_item(
                Key={"security_ref": bucket_ref},
                UpdateExpression=(
                    "SET schema_version = :schema, #kind = :kind, identity_ref = :identity, "
                    "window_started_at = :started, window_expires_at = :window, expires_at = :expires "
                    "ADD failure_count :one"
                ),
                ExpressionAttributeNames={"#kind": "kind"},
                ExpressionAttributeValues={
                    ":schema": "shirone-auth-failure-window-v1",
                    ":kind": kind,
                    ":identity": identity_ref,
                    ":started": started_at,
                    ":window": started_at + window_seconds,
                    ":expires": expires_at,
                    ":one": 1,
                },
                ReturnValues="UPDATED_NEW",
            )
            count = int((result.get("Attributes") or {}).get("failure_count", 0))
        except Exception as error:
            raise AuthSecurityUnavailable("auth security state unavailable") from error
        return count, started_at + window_seconds

    def _lock_ref(self, account: str) -> str:
        account_ref = self._identity_ref("account", account)
        return hmac_reference(self.config.hash_secret, "account-lock", account_ref)

    def check(self, *, account: str, source_ip: str, now: Optional[int] = None):
        current = self.clock() if now is None else now
        lock = self._get(self._lock_ref(account)) or {}
        lock_expires_at = int(lock.get("lock_expires_at", 0) or 0)
        if lock_expires_at > current:
            return max(1, lock_expires_at - current)

        _, ip_bucket_ref, _, = self._bucket("ip", source_ip, self.config.ip_window_seconds, current)
        ip_state = self._get(ip_bucket_ref) or {}
        ip_count = int(ip_state.get("failure_count", 0) or 0)
        ip_window_expires_at = int(ip_state.get("window_expires_at", 0) or 0)
        if ip_count >= self.config.ip_failure_limit and ip_window_expires_at > current:
            return max(1, ip_window_expires_at - current)
        return None

    def record_failure(self, *, account: str, source_ip: str, now: Optional[int] = None):
        current = self.clock() if now is None else now
        account_count, _ = self._increment(
            kind="account",
            raw_value=account,
            limit=self.config.account_failure_limit,
            window_seconds=self.config.account_window_seconds,
            now=current,
        )
        ip_count, ip_expires_at = self._increment(
            kind="ip",
            raw_value=source_ip,
            limit=self.config.ip_failure_limit,
            window_seconds=self.config.ip_window_seconds,
            now=current,
        )
        retry_after = None
        if account_count >= self.config.account_failure_limit:
            lock_expires_at = current + self.config.account_lock_seconds
            try:
                self.table.put_item(
                    Item={
                        "security_ref": self._lock_ref(account),
                        "schema_version": "shirone-auth-account-lock-v1",
                        "kind": "account_lock",
                        "lock_expires_at": lock_expires_at,
                        "expires_at": lock_expires_at + self.config.account_window_seconds,
                    },
                    ConditionExpression="attribute_not_exists(lock_expires_at) OR lock_expires_at <= :now",
                    ExpressionAttributeValues={":now": current},
                )
            except Exception as error:
                # Conditional failure means another concurrent request installed the lock.
                if error.__class__.__name__ != "ConditionalCheckFailedException":
                    raise AuthSecurityUnavailable("auth security state unavailable") from error
            retry_after = self.config.account_lock_seconds
        if ip_count >= self.config.ip_failure_limit:
            retry_after = max(retry_after or 0, max(1, ip_expires_at - current))
        return retry_after

    def record_success(self, *, account: str, now: Optional[int] = None):
        current = self.clock() if now is None else now
        _, bucket_ref, _, = self._bucket("account", account, self.config.account_window_seconds, current)
        try:
            self.table.delete_item(Key={"security_ref": bucket_ref})
            self.table.delete_item(Key={"security_ref": self._lock_ref(account)})
        except Exception as error:
            raise AuthSecurityUnavailable("auth security state unavailable") from error


def source_ip_from_event(event) -> str:
    request_context = event.get("requestContext") if isinstance(event, dict) else {}
    request_context = request_context if isinstance(request_context, dict) else {}
    http_context = request_context.get("http")
    if isinstance(http_context, dict) and isinstance(http_context.get("sourceIp"), str):
        return http_context["sourceIp"]
    identity = request_context.get("identity")
    if isinstance(identity, dict) and isinstance(identity.get("sourceIp"), str):
        return identity["sourceIp"]
    return "unknown"
