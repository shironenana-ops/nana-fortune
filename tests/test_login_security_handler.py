"""Handler-level regression checks using local fake DynamoDB modules only."""

import hashlib
import importlib.util
import json
import os
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAMBDA_DIR = ROOT / "lambda"
sys.path.insert(0, str(LAMBDA_DIR))


class ClientError(Exception):
    def __init__(self, code="ConditionalCheckFailedException"):
        self.response = {"Error": {"Code": code}}


class FakeTable:
    def __init__(self, items=None):
        self.items = items if items is not None else {}

    def get_item(self, *, Key):
        item = self.items.get(Key.get("user_id") or Key.get("security_ref"))
        return {"Item": item.copy()} if item else {}

    def update_item(self, *, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None, ExpressionAttributeNames=None, **_kwargs):
        key = Key.get("user_id") or Key.get("security_ref")
        item = self.items.setdefault(key, Key.copy())
        if ConditionExpression and "#password = :old_password" in ConditionExpression:
            if item.get("password") != ExpressionAttributeValues[":old_password"]:
                raise ClientError()
            item["password"] = ExpressionAttributeValues[":password"]
        if "ADD failure_count" in UpdateExpression:
            item["failure_count"] = int(item.get("failure_count", 0)) + 1
            item["window_expires_at"] = ExpressionAttributeValues[":window"]
        if "last_login_at" in UpdateExpression:
            item["last_login_at"] = ExpressionAttributeValues[":now"]
        return {"Attributes": item.copy()}

    def put_item(self, *, Item, **_kwargs):
        self.items[Item.get("user_id") or Item.get("security_ref")] = Item.copy()

    def delete_item(self, *, Key, **_kwargs):
        self.items.pop(Key.get("user_id") or Key.get("security_ref"), None)


class FakeDynamo:
    def __init__(self, users, security):
        self.users = users
        self.security = security

    def Table(self, name):
        return self.security if name == "security" else self.users


def load_login(users, security):
    fake_boto3 = types.SimpleNamespace(resource=lambda _name: FakeDynamo(users, security))
    fake_exceptions = types.SimpleNamespace(ClientError=ClientError)
    previous = {name: sys.modules.get(name) for name in ("boto3", "botocore", "botocore.exceptions")}
    sys.modules["boto3"] = fake_boto3
    sys.modules["botocore"] = types.SimpleNamespace(exceptions=fake_exceptions)
    sys.modules["botocore.exceptions"] = fake_exceptions
    try:
        spec = importlib.util.spec_from_file_location("login_security_under_test", LAMBDA_DIR / "login.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


class LoginSecurityHandlerTests(unittest.TestCase):
    def setUp(self):
        self.saved_env = os.environ.copy()
        os.environ["SESSION_TOKEN_SECRET"] = "local-test-session-secret"
        for name in (
            "AUTH_SECURITY_ENABLED", "AUTH_SECURITY_TABLE_NAME", "AUTH_SECURITY_HASH_SECRET",
            "AUTH_ACCOUNT_FAILURE_LIMIT", "AUTH_ACCOUNT_WINDOW_SECONDS", "AUTH_ACCOUNT_LOCK_SECONDS",
            "AUTH_IP_FAILURE_LIMIT", "AUTH_IP_WINDOW_SECONDS", "EMAIL_VERIFICATION_ENABLED",
        ):
            os.environ.pop(name, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved_env)

    @staticmethod
    def event(email, password):
        return {
            "requestContext": {"http": {"method": "POST", "sourceIp": "203.0.113.10"}},
            "body": json.dumps({"email": email, "password": password}),
        }

    def test_successful_legacy_login_migrates_only_the_verified_old_hash(self):
        email = "name@example.invalid"
        old = hashlib.sha256(b"correct horse battery staple").hexdigest()
        users = FakeTable({email: {"user_id": email, "password": old}})
        login = load_login(users, FakeTable())
        response = login.lambda_handler(self.event(email, "correct horse battery staple"), None)
        self.assertEqual(200, response["statusCode"])
        self.assertTrue(users.items[email]["password"].startswith("pbkdf2_sha256$600000$"))

    def test_wrong_legacy_password_does_not_migrate(self):
        email = "name@example.invalid"
        old = hashlib.sha256(b"correct horse battery staple").hexdigest()
        users = FakeTable({email: {"user_id": email, "password": old}})
        login = load_login(users, FakeTable())
        response = login.lambda_handler(self.event(email, "wrong password"), None)
        self.assertEqual(401, response["statusCode"])
        self.assertEqual(old, users.items[email]["password"])

    def test_enabled_unverified_account_returns_fixed_403_without_session_token(self):
        os.environ.update({
            "EMAIL_VERIFICATION_ENABLED": "true",
            "AUTH_SECURITY_TABLE_NAME": "security",
            "EMAIL_VERIFICATION_TOKEN_SECRET": "local-token-secret",
            "EMAIL_VERIFICATION_FROM_ADDRESS": "no-reply@example.invalid",
            "EMAIL_VERIFICATION_BASE_URL": "https://example.invalid",
            "AWS_REGION": "ap-northeast-1",
            "EMAIL_VERIFICATION_RESEND_SECONDS": "60",
            "EMAIL_VERIFICATION_TTL_SECONDS": "86400",
        })
        email = "name@example.invalid"
        users = FakeTable({email: {"user_id": email, "password": "pbkdf2_sha256$600000$invalid$invalid", "email_verified": False}})
        # Construct a valid modern record through the imported shared module.
        from auth_security import password_hash
        users.items[email]["password"] = password_hash("correct horse battery staple")
        login = load_login(users, FakeTable())
        response = login.lambda_handler(self.event(email, "correct horse battery staple"), None)
        body = json.loads(response["body"])
        self.assertEqual(403, response["statusCode"])
        self.assertEqual("EMAIL_VERIFICATION_REQUIRED", body["code"])
        self.assertNotIn("token", body)


if __name__ == "__main__":
    unittest.main()
