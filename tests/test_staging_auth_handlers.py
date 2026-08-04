"""Local-only staging auth handler tests with fake DynamoDB dependencies."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from botocore.exceptions import ClientError


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lambda"))
sys.path.insert(0, str(ROOT / "scripts"))

from auth_security import password_hash
from staging_login import LoginDependencies, _dependencies as login_dependencies, lambda_handler as login_handler
from staging_signup import SignupDependencies, _dependencies as signup_dependencies, lambda_handler as signup_handler
from build_staging_auth_lambdas import build_package


class FakeTable:
    def __init__(self, items=None, *, unavailable=False):
        self.items = items if items is not None else {}
        self.calls = []
        self.unavailable = unavailable

    def get_item(self, *, Key):
        self.calls.append(("get_item", Key))
        if self.unavailable:
            raise RuntimeError("unavailable")
        key = Key.get("user_id") or Key.get("security_ref")
        item = self.items.get(key)
        return {"Item": item.copy()} if item else {}

    def update_item(self, **kwargs):
        self.calls.append(("update_item", kwargs))
        if self.unavailable:
            raise RuntimeError("unavailable")
        values = kwargs.get("ExpressionAttributeValues", {})
        if ":one" in values:
            return {"Attributes": {"failure_count": 1}}
        key = kwargs.get("Key", {}).get("user_id")
        if key in self.items and ":now" in values:
            self.items[key]["updated_at"] = values[":now"]
        return {}

    def put_item(self, **kwargs):
        self.calls.append(("put_item", kwargs))
        if self.unavailable:
            raise RuntimeError("unavailable")
        item = kwargs.get("Item", {})
        key = item.get("user_id") or item.get("security_ref")
        if key in self.items and kwargs.get("ConditionExpression") == "attribute_not_exists(user_id)":
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "fixture"}}, "PutItem")
        self.items[key] = item.copy()
        return {}

    def delete_item(self, **kwargs):
        self.calls.append(("delete_item", kwargs))
        if self.unavailable:
            raise RuntimeError("unavailable")
        return {}


def event(path, method="POST", body=None, origin="http://127.0.0.1:4321"):
    return {
        "version": "2.0",
        "routeKey": f"{method} {path}",
        "rawPath": f"/staging{path}",
        "requestContext": {"http": {"method": method, "sourceIp": "192.0.2.10"}},
        "headers": {"origin": origin, "content-type": "application/json"},
        "body": json.dumps(body or {}),
    }


class StagingAuthHandlerTests(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.copy()
        os.environ.update(
            {
                "STAGING_ENVIRONMENT": "staging",
                "AWS_REGION": "ap-northeast-1",
                "ALLOWED_ORIGINS": "http://127.0.0.1:4321,http://localhost:4321",
                "STAGING_LOGIN_ENABLED": "true",
                "STAGING_SIGNUP_ENABLED": "true",
                "EMAIL_VERIFICATION_ENABLED": "false",
                "AUTH_SECURITY_ENABLED": "true",
                "AUTH_SECURITY_TABLE_NAME": "fixture-auth-attempts",
                "AUTH_ACCOUNT_FAILURE_LIMIT": "5",
                "AUTH_ACCOUNT_WINDOW_SECONDS": "900",
                "AUTH_ACCOUNT_LOCK_SECONDS": "900",
                "AUTH_IP_FAILURE_LIMIT": "20",
                "AUTH_IP_WINDOW_SECONDS": "900",
            }
        )

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)

    def test_valid_login_uses_existing_hash_and_token_contract(self):
        email = "browser-check@staging.invalid"
        users = FakeTable({email: {"user_id": email, "password": password_hash("safe test password")}})
        security = FakeTable()
        response = login_handler(
            event("/login", body={"email": email, "password": "safe test password"}),
            None,
            LoginDependencies(users, security, "s" * 32),
        )
        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["user_id"], email)
        self.assertEqual(body["token"].count("."), 1)
        self.assertTrue(any(call[0] == "delete_item" for call in security.calls))

    def test_wrong_password_and_unknown_user_use_same_generic_contract(self):
        email = "browser-check@staging.invalid"
        users = FakeTable({email: {"user_id": email, "password": password_hash("safe test password")}})
        results = []
        for candidate in ((email, "wrong password"), ("missing@staging.invalid", "wrong password")):
            response = login_handler(
                event("/login", body={"email": candidate[0], "password": candidate[1]}),
                None,
                LoginDependencies(users, FakeTable(), "s" * 32),
            )
            results.append((response["statusCode"], json.loads(response["body"])["error"]["message"]))
        self.assertEqual(results, [(401, "email or password is invalid"), (401, "email or password is invalid")])

    def test_login_disabled_and_rate_store_unavailable_fail_closed(self):
        os.environ["STAGING_LOGIN_ENABLED"] = "false"
        users = FakeTable()
        response = login_handler(event("/login"), None, LoginDependencies(users, FakeTable(), "s" * 32))
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(users.calls, [])
        os.environ["STAGING_LOGIN_ENABLED"] = "true"
        response = login_handler(
            event("/login", body={"email": "name@staging.invalid", "password": "safe test password"}),
            None,
            LoginDependencies(FakeTable(), FakeTable(unavailable=True), "s" * 32),
        )
        self.assertEqual(response["statusCode"], 503)

    def test_login_rejects_unknown_origin_and_production_boundary(self):
        response = login_handler(event("/login", origin="https://example.com"), None, LoginDependencies(FakeTable(), FakeTable(), "s" * 32))
        self.assertEqual(response["statusCode"], 403)
        os.environ["STAGING_ENVIRONMENT"] = "production"
        response = login_handler(event("/login"), None, LoginDependencies(FakeTable(), FakeTable(), "s" * 32))
        self.assertEqual(response["statusCode"], 503)

    def test_runtime_table_binding_rejects_production_names_before_aws_access(self):
        os.environ["STAGING_ENVIRONMENT"] = "staging"
        os.environ["USERS_TABLE_NAME"] = "production-users"
        os.environ["AUTH_SECURITY_TABLE_NAME"] = "nana-reading-staging-attempts"
        with self.assertRaises(Exception):
            login_dependencies()
        with self.assertRaises(Exception):
            signup_dependencies()

    def test_signup_accepts_only_non_personal_staging_invalid_accounts(self):
        users = FakeTable()
        response = signup_handler(
            event("/signup", body={"email": "browser-check@staging.invalid", "password": "safe test password"}),
            None,
            SignupDependencies(users),
        )
        self.assertEqual(response["statusCode"], 200)
        item = users.items["browser-check@staging.invalid"]
        self.assertEqual(item["plan"], "free")
        self.assertEqual(item["membership_schema_version"], "shirone-membership-v1")
        self.assertTrue(item["password"].startswith("pbkdf2_sha256$600000$"))
        real = signup_handler(
            event("/signup", body={"email": "person@example.com", "password": "safe test password"}),
            None,
            SignupDependencies(users),
        )
        self.assertEqual(real["statusCode"], 400)

    def test_duplicate_signup_is_generic_and_disabled_signup_has_no_write(self):
        email = "browser-check@staging.invalid"
        users = FakeTable({email: {"user_id": email}})
        duplicate = signup_handler(
            event("/signup", body={"email": email, "password": "safe test password"}),
            None,
            SignupDependencies(users),
        )
        self.assertEqual(duplicate["statusCode"], 200)
        os.environ["STAGING_SIGNUP_ENABLED"] = "false"
        calls = len(users.calls)
        disabled = signup_handler(event("/signup"), None, SignupDependencies(users))
        self.assertEqual(disabled["statusCode"], 503)
        self.assertEqual(len(users.calls), calls)

    def test_packages_are_reproducible_and_allow_list_only(self):
        with tempfile.TemporaryDirectory() as directory:
            for kind, expected in {
                "login": {"index.py", "staging_auth_common.py", "staging_runtime_secret.py", "auth_security.py", "session_token.py"},
                "signup": {"index.py", "staging_auth_common.py", "auth_security.py"},
            }.items():
                first = Path(directory) / f"{kind}.zip"
                second = Path(directory) / f"{kind}-2.zip"
                build_package(kind, first)
                build_package(kind, second)
                self.assertEqual(first.read_bytes(), second.read_bytes())
                with zipfile.ZipFile(first) as archive:
                    self.assertEqual(set(archive.namelist()), expected)


if __name__ == "__main__":
    unittest.main()
