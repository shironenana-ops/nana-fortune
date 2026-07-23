"""Shared, non-networking state transitions for email verification handlers."""

from datetime import datetime, timezone

from auth_security import (
    AuthSecurityError,
    AuthSecurityUnavailable,
    EmailVerificationConfig,
    SesV2EmailSender,
    create_verification_token,
    hmac_reference,
    now_epoch,
)


TOKEN_SCHEMA_VERSION = "shirone-email-verification-token-v1"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def user_reference(config: EmailVerificationConfig, email: str) -> str:
    return hmac_reference(config.token_secret, "email-verification-user", email)


def issue_verification(*, users_table, security_table, email, config, sender=None, now=None):
    """Create one opaque token state record, then deliver it without logging it.

    The opaque reference, rather than email, is the Security table primary key.
    A failed delivery removes the newly-issued state so the user can safely retry.
    """
    current = now_epoch() if now is None else now
    token = create_verification_token(config)
    expires_at = current + config.token_ttl_seconds
    resend_at = current + config.resend_interval_seconds
    item = {
        "security_ref": token.reference,
        "schema_version": TOKEN_SCHEMA_VERSION,
        "kind": "email_verification",
        "token_digest": token.digest,
        "user_id": email,
        "user_ref": user_reference(config, email),
        "created_at": current,
        "expires_at": expires_at,
    }

    try:
        security_table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(security_ref)",
        )
        users_table.update_item(
            Key={"user_id": email},
            UpdateExpression=(
                "SET email_verified = :pending, email_verification_ref = :reference, "
                "email_verification_resend_at = :resend_at, updated_at = :updated_at"
            ),
            ExpressionAttributeValues={
                ":pending": False,
                ":reference": token.reference,
                ":resend_at": resend_at,
                ":updated_at": _now_iso(),
            },
        )
    except Exception as error:
        raise AuthSecurityUnavailable("email verification state unavailable") from error

    actual_sender = sender or SesV2EmailSender(config.aws_region)
    try:
        actual_sender.send_verification(config=config, recipient=email, token=token)
    except Exception as error:
        # Never retain an undelivered token as an apparently usable credential.
        try:
            security_table.delete_item(Key={"security_ref": token.reference})
            users_table.update_item(
                Key={"user_id": email},
                UpdateExpression=(
                    "REMOVE email_verification_ref, email_verification_resend_at "
                    "SET updated_at = :updated_at"
                ),
                ConditionExpression="email_verification_ref = :reference",
                ExpressionAttributeValues={":reference": token.reference, ":updated_at": _now_iso()},
            )
        except Exception:
            pass
        raise AuthSecurityUnavailable("email delivery unavailable") from error

    return {"expires_at": expires_at, "resend_at": resend_at}


def verify_verification_token(*, users_table, security_table, token, config, now=None):
    """Consume one token with conditional user state and a safe replay rejection."""
    current = now_epoch() if now is None else now
    try:
        record = security_table.get_item(Key={"security_ref": token.reference}).get("Item")
    except Exception as error:
        raise AuthSecurityUnavailable("email verification state unavailable") from error

    if not isinstance(record, dict):
        return False
    email = record.get("user_id") if isinstance(record.get("user_id"), str) else ""
    if (
        record.get("schema_version") != TOKEN_SCHEMA_VERSION
        or record.get("kind") != "email_verification"
        or record.get("token_digest") != token.digest
        or not email
        or record.get("user_ref") != user_reference(config, email)
        or int(record.get("expires_at", 0) or 0) <= current
    ):
        return False

    try:
        users_table.update_item(
            Key={"user_id": email},
            UpdateExpression=(
                "SET email_verified = :verified, email_verified_at = :verified_at, updated_at = :updated_at "
                "REMOVE email_verification_ref, email_verification_resend_at"
            ),
            ConditionExpression="email_verified = :pending AND email_verification_ref = :reference",
            ExpressionAttributeValues={
                ":verified": True,
                ":pending": False,
                ":reference": token.reference,
                ":verified_at": _now_iso(),
                ":updated_at": _now_iso(),
            },
        )
    except Exception as error:
        if error.__class__.__name__ == "ConditionalCheckFailedException":
            return False
        raise AuthSecurityUnavailable("email verification state unavailable") from error

    try:
        security_table.delete_item(
            Key={"security_ref": token.reference},
            ConditionExpression="token_digest = :digest",
            ExpressionAttributeValues={":digest": token.digest},
        )
    except Exception:
        # The user-side conditional state prevents replay even if best-effort
        # token cleanup is unavailable.
        pass
    return True
