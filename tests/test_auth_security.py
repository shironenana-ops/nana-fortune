"""Local-only regression tests for authentication security primitives."""

import hashlib
import os
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambda"))

from auth_security import (  # noqa: E402
    AuthAttemptLimiter,
    AuthSecurityError,
    AuthSecurityConfig,
    password_hash,
    password_matches,
    read_auth_security_config,
)


class ConditionalCheckFailedException(Exception):
    pass


class MemoryTable:
    def __init__(self):
        self.items = {}
        self.keys_seen = []

    def get_item(self, *, Key):
        self.keys_seen.append(Key.copy())
        value = self.items.get(next(iter(Key.values())))
        return {"Item": value.copy()} if value else {}

    def put_item(self, *, Item, ConditionExpression=None, ExpressionAttributeValues=None):
        key = Item.get("security_ref") or Item.get("user_id")
        if ConditionExpression and "attribute_not_exists" in ConditionExpression and key in self.items:
            raise ConditionalCheckFailedException()
        if ConditionExpression and "lock_expires_at" in ConditionExpression:
            old = self.items.get(key, {})
            if old.get("lock_expires_at", 0) > ExpressionAttributeValues[":now"]:
                raise ConditionalCheckFailedException()
        self.items[key] = Item.copy()

    def update_item(
        self,
        *,
        Key,
        UpdateExpression,
        ExpressionAttributeValues,
        ExpressionAttributeNames=None,
        ConditionExpression=None,
        ReturnValues=None,
    ):
        key = Key.get("security_ref") or Key.get("user_id")
        item = self.items.setdefault(key, Key.copy())
        if ConditionExpression and "email_verified = :pending" in ConditionExpression:
            if item.get("email_verified") is not ExpressionAttributeValues[":pending"] or item.get("email_verification_ref") != ExpressionAttributeValues[":reference"]:
                raise ConditionalCheckFailedException()
        if ConditionExpression and "email_verification_ref = :reference" in ConditionExpression:
            if item.get("email_verification_ref") != ExpressionAttributeValues[":reference"]:
                raise ConditionalCheckFailedException()
        if "ADD failure_count" in UpdateExpression:
            item.update({
                "schema_version": ExpressionAttributeValues[":schema"],
                "kind": ExpressionAttributeValues[":kind"],
                "identity_ref": ExpressionAttributeValues[":identity"],
                "window_started_at": ExpressionAttributeValues[":started"],
                "window_expires_at": ExpressionAttributeValues[":window"],
                "expires_at": ExpressionAttributeValues[":expires"],
            })
            item["failure_count"] = int(item.get("failure_count", 0)) + 1
        elif "email_verified = :pending" in UpdateExpression:
            item.update({
                "email_verified": False,
                "email_verification_ref": ExpressionAttributeValues[":reference"],
                "email_verification_resend_at": ExpressionAttributeValues[":resend_at"],
            })
        elif "email_verified = :verified" in UpdateExpression:
            item["email_verified"] = True
            item.pop("email_verification_ref", None)
            item.pop("email_verification_resend_at", None)
        elif "REMOVE email_verification_ref" in UpdateExpression:
            item.pop("email_verification_ref", None)
            item.pop("email_verification_resend_at", None)
        return {"Attributes": item.copy()}

    def delete_item(self, *, Key, **_kwargs):
        self.items.pop(Key.get("security_ref") or Key.get("user_id"), None)


class AuthSecurityTests(unittest.TestCase):
    def setUp(self):
        self.auth_config = AuthSecurityConfig("security", "test-hash-secret", 5, 900, 900, 20, 900)

    def test_pbkdf2_is_versioned_unique_and_rejects_invalid(self):
        first = password_hash("correct horse battery staple")
        second = password_hash("correct horse battery staple")
        self.assertTrue(first.startswith("pbkdf2_sha256$600000$"))
        self.assertNotEqual(first, second)
        self.assertTrue(password_matches("correct horse battery staple", first).accepted)
        self.assertFalse(password_matches("wrong password", first).accepted)
        self.assertFalse(password_matches("correct horse battery staple", "pbkdf2_sha256$1$x$y").accepted)
        self.assertFalse(password_matches("short", first).accepted)

    def test_legacy_sha256_is_detected_but_wrong_value_never_migrates(self):
        legacy = hashlib.sha256(b"correct horse battery staple").hexdigest()
        verified = password_matches("correct horse battery staple", legacy)
        self.assertTrue(verified.accepted)
        self.assertTrue(verified.legacy)
        self.assertFalse(password_matches("wrong password", legacy).accepted)
        self.assertFalse(password_matches("correct horse battery staple", "not-a-hash").accepted)

    def test_enabled_controls_fail_closed_when_configuration_is_missing(self):
        with self.assertRaises(AuthSecurityError):
            read_auth_security_config({"AUTH_SECURITY_ENABLED": "true"})
        self.assertIsNone(read_auth_security_config({}))

    def test_rate_limit_uses_hmac_references_and_resets_only_account(self):
        state = MemoryTable()
        limiter = AuthAttemptLimiter(state, self.auth_config, clock=lambda: 1_000)
        for _ in range(4):
            self.assertIsNone(limiter.record_failure(account="name@example.invalid", source_ip="203.0.113.10"))
        self.assertEqual(900, limiter.record_failure(account="name@example.invalid", source_ip="203.0.113.10"))
        self.assertEqual(900, limiter.check(account="name@example.invalid", source_ip="203.0.113.10"))
        limiter.record_success(account="name@example.invalid")
        self.assertIsNone(limiter.check(account="name@example.invalid", source_ip="203.0.113.10"))
        persisted = repr(state.items)
        self.assertNotIn("name@example.invalid", persisted)
        self.assertNotIn("203.0.113.10", persisted)

if __name__ == "__main__":
    unittest.main()
