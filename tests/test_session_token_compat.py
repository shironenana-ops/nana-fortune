"""Golden-vector and local login Lambda packaging compatibility tests."""

import base64
import hashlib
import hmac
import importlib.util
import json
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAMBDA_DIR = ROOT / "lambda"
sys.path.insert(0, str(LAMBDA_DIR))

from session_token import SESSION_TTL_SECONDS, create_session_token


GOLDEN_SECRET = "golden-vector-secret-not-for-production"
GOLDEN_USER_ID = "reading-golden@staging.invalid"
GOLDEN_ISSUED_AT = 1_700_000_000
GOLDEN_EXPIRES_AT = 1_700_086_400
GOLDEN_PAYLOAD_JSON = (
    '{"user_id":"reading-golden@staging.invalid","iat":1700000000,"exp":1700086400}'
)
GOLDEN_TOKEN = (
    "eyJ1c2VyX2lkIjoicmVhZGluZy1nb2xkZW5Ac3RhZ2luZy5pbnZhbGlkIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwODY0MDB9"
    ".6cWyYQ_3g05JKTx0Ko_OaKF6ADuTBcsAjXyAvlJVLwQ"
)


def legacy_token(user_id: str, secret: str, issued_at: int) -> str:
    """Exact pre-refactor algorithm retained only as a regression oracle."""
    payload = {"user_id": user_id, "iat": issued_at, "exp": issued_at + 60 * 60 * 24}
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_part = base64.urlsafe_b64encode(payload_json).decode("utf-8").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    signature_part = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"{payload_part}.{signature_part}"


def decode_payload(token: str) -> dict:
    payload_part = token.split(".", 1)[0]
    raw = base64.urlsafe_b64decode(payload_part + "=" * (-len(payload_part) % 4))
    return json.loads(raw.decode("utf-8"))


def legacy_verify(token: str, secret: str, now: int) -> bool:
    if token.count(".") != 1:
        return False
    payload_part, signature_part = token.split(".", 1)
    expected = hmac.new(secret.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    try:
        actual = base64.urlsafe_b64decode(signature_part + "=" * (-len(signature_part) % 4))
        payload = decode_payload(token)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return hmac.compare_digest(expected, actual) and payload.get("exp", -1) >= now


class SessionTokenCompatibilityTests(unittest.TestCase):
    def test_golden_vector_matches_legacy_and_shared_helper(self):
        self.assertEqual(SESSION_TTL_SECONDS, 86_400)
        self.assertEqual(GOLDEN_EXPIRES_AT, GOLDEN_ISSUED_AT + SESSION_TTL_SECONDS)
        current = create_session_token(GOLDEN_USER_ID, secret=GOLDEN_SECRET, now=GOLDEN_ISSUED_AT)
        self.assertEqual(current, GOLDEN_TOKEN)
        self.assertEqual(current, legacy_token(GOLDEN_USER_ID, GOLDEN_SECRET, GOLDEN_ISSUED_AT))
        self.assertEqual(json.dumps(decode_payload(current), separators=(",", ":")), GOLDEN_PAYLOAD_JSON)
        self.assertEqual(current.count("."), 1)
        self.assertNotIn("=", current)

    def test_golden_claims_and_expiration_boundary_match_server_contract(self):
        payload = decode_payload(GOLDEN_TOKEN)
        self.assertEqual(set(payload), {"user_id", "iat", "exp"})
        self.assertEqual(payload["user_id"], GOLDEN_USER_ID)
        self.assertEqual(payload["iat"], GOLDEN_ISSUED_AT)
        self.assertEqual(payload["exp"], GOLDEN_EXPIRES_AT)
        self.assertTrue(legacy_verify(GOLDEN_TOKEN, GOLDEN_SECRET, GOLDEN_EXPIRES_AT))
        self.assertFalse(legacy_verify(GOLDEN_TOKEN, GOLDEN_SECRET, GOLDEN_EXPIRES_AT + 1))
        self.assertFalse(legacy_verify(GOLDEN_TOKEN, "different-fixture-secret", GOLDEN_EXPIRES_AT))

    def test_login_lambda_package_contains_helper_and_imports_from_zip_layout(self):
        spec = importlib.util.spec_from_file_location("build_login_lambda", ROOT / "scripts" / "build_login_lambda.py")
        builder = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "login.zip"
            builder.build_package(archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(set(archive.namelist()), {"login.py", "auth_security.py", "session_token.py"})
                archive.extractall(Path(directory) / "extracted")
            extracted = Path(directory) / "extracted"
            previous_path = list(sys.path)
            module_names = ("boto3", "botocore", "botocore.exceptions", "auth_security", "session_token")
            previous_modules = {name: sys.modules.get(name) for name in module_names}
            fake_table = types.SimpleNamespace()
            fake_boto3 = types.SimpleNamespace(resource=lambda _name: types.SimpleNamespace(Table=lambda _table: fake_table))
            fake_exceptions = types.SimpleNamespace(ClientError=Exception)
            sys.modules["boto3"] = fake_boto3
            sys.modules["botocore"] = types.SimpleNamespace(exceptions=fake_exceptions)
            sys.modules["botocore.exceptions"] = fake_exceptions
            sys.modules.pop("auth_security", None)
            sys.modules.pop("session_token", None)
            sys.path.insert(0, str(extracted))
            try:
                login_spec = importlib.util.spec_from_file_location("packaged_login", extracted / "login.py")
                login = importlib.util.module_from_spec(login_spec)
                assert login_spec and login_spec.loader
                login_spec.loader.exec_module(login)
                self.assertEqual(
                    login.create_session_token(GOLDEN_USER_ID, secret=GOLDEN_SECRET, now=GOLDEN_ISSUED_AT),
                    GOLDEN_TOKEN,
                )
            finally:
                sys.path[:] = previous_path
                for name, value in previous_modules.items():
                    if value is None:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = value


if __name__ == "__main__":
    unittest.main()
