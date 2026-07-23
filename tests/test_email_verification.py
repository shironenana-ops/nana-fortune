"""Local mocked state tests for opaque email verification tokens."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambda"))

from auth_security import EmailVerificationConfig, create_verification_token, parse_verification_token
from email_verification import issue_verification, verify_verification_token
from test_auth_security import MemoryTable


class FakeSender:
    def __init__(self):
        self.sent = []

    def send_verification(self, *, config, recipient, token):
        self.sent.append((recipient, token.raw))


class EmailVerificationTests(unittest.TestCase):
    def setUp(self):
        self.config = EmailVerificationConfig(
            "security", "test-token-secret", "no-reply@example.invalid", "https://example.invalid", "ap-northeast-1", 60, 86400
        )

    def test_token_is_opaque_single_use_and_expiry_checked(self):
        users = MemoryTable()
        users.items["name@example.invalid"] = {"user_id": "name@example.invalid", "email_verified": False}
        security = MemoryTable()
        sender = FakeSender()
        issue_verification(users_table=users, security_table=security, email="name@example.invalid", config=self.config, sender=sender, now=1_000)
        raw = sender.sent[0][1]
        token = parse_verification_token(raw, self.config)
        self.assertNotIn(raw, repr(security.items))
        self.assertTrue(verify_verification_token(users_table=users, security_table=security, token=token, config=self.config, now=1_001))
        self.assertFalse(verify_verification_token(users_table=users, security_table=security, token=token, config=self.config, now=1_002))
        self.assertTrue(users.items["name@example.invalid"]["email_verified"])

    def test_expired_or_wrong_state_is_rejected(self):
        users = MemoryTable()
        users.items["name@example.invalid"] = {"user_id": "name@example.invalid", "email_verified": False}
        security = MemoryTable()
        token = create_verification_token(self.config)
        security.items[token.reference] = {
            "security_ref": token.reference, "schema_version": "shirone-email-verification-token-v1",
            "kind": "email_verification", "token_digest": token.digest, "user_id": "name@example.invalid",
            "user_ref": "wrong", "expires_at": 999,
        }
        self.assertFalse(verify_verification_token(users_table=users, security_table=security, token=token, config=self.config, now=1_000))


if __name__ == "__main__":
    unittest.main()
