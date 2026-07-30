import contextlib
import importlib.util
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "reading_staging_cli_harness", ROOT / "scripts" / "reading_staging_cli_harness.py"
)
HARNESS = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = HARNESS
SPEC.loader.exec_module(HARNESS)


class FakeBackend:
    def __init__(self, existing=None):
        self.user = existing
        self.puts = 0
        self.boundary = 0
        self.runtime = 0
        self.secret = "unit-only-session-secret-never-for-aws"
        self.changed = False
        self.metrics_checked = 0

    def validate_boundary(self):
        self.boundary += 1

    def validate_runtime(self):
        self.runtime += 1
        return self.secret

    def get_item(self, logical_id, key):
        if logical_id == "ReadingUsersTable":
            return self.user
        return None

    def put_test_user(self, item, fixture_password, password_matches, session_secret):
        if session_secret != self.secret:
            raise AssertionError("unexpected session secret")
        self.puts += 1
        self.user = item
        return True

    def side_effect_state(self):
        value = {
            "queues": {"light": 0, "deep": 0},
            "esm": {"light": "Disabled", "deep": "Disabled"},
            "test_user": self.user,
            "missing_job": None,
        }
        if self.changed:
            value["queues"]["light"] = 1
        return value

    def api_base(self):
        return "https://fixture.execute-api.ap-northeast-1.amazonaws.com/staging"

    def validate_no_worker_or_bedrock_invocations(self, started_at, finished_at, expected_state):
        self.assert_timestamps = (started_at, finished_at)
        self.assert_expected_state = expected_state
        self.metrics_checked += 1
        return {
            "classification": {
                "LightWorkerFunction": HARNESS.METRIC_MEASURED_ZERO,
                "DeepWorkerFunction": HARNESS.METRIC_MEASURED_ZERO,
                "Bedrock": HARNESS.METRIC_MEASURED_ZERO,
            },
            "measured_sum": {
                "LightWorkerFunction": 0.0,
                "DeepWorkerFunction": 0.0,
                "Bedrock": 0.0,
            },
            "deterministic_controls": "PASS",
            "evidence_label": HARNESS.EVIDENCE_ZERO_MEASURED,
        }


def valid_user():
    password_hash, _, _ = HARNESS._lambda_imports()
    fixture_password = HARNESS._fixture_password("unit-only-session-secret-never-for-aws")
    return {
        "user_id": {"S": HARNESS.TEST_USER_ID},
        "password": {"S": password_hash(fixture_password, salt=b"0123456789abcdef")},
        "plan": {"S": "light"},
        "subscription_status": {"S": "active"},
    }


class HarnessTests(unittest.TestCase):
    def test_config_requires_exact_staging_account_without_secret_arn(self):
        env = {"SHIRONE_STAGING_EXPECTED_ACCOUNT_ID": "123456789012"}
        self.assertEqual(HARNESS.load_config(env).expected_account_id, "123456789012")
        for invalid in (
            {},
            {**env, "SHIRONE_STAGING_EXPECTED_ACCOUNT_ID": "123"},
        ):
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.load_config(invalid)
    def test_dry_run_does_not_construct_aws_backend(self):
        with mock.patch.object(HARNESS.AwsSdkBackend, "create", side_effect=AssertionError("must not construct")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(HARNESS.main([]), 0)
        self.assertEqual(output.getvalue().strip(), "STAGING_CLI_HARNESS_DRY_RUN_ONLY")

    def test_creates_one_minimal_user_and_keeps_token_in_process_only(self):
        backend = FakeBackend()
        calls = []

        def request(base, method, path, token, body=None, idempotency_key=None):
            self.assertTrue(token)
            self.assertNotIn(token, calls)
            calls.append((method, path, sorted((body or {}).keys()), bool(idempotency_key)))
            return (503, "READING_ASYNC_PAID_DISABLED") if method == "POST" else (404, "READING_STATUS_NOT_FOUND")

        output = io.StringIO()
        with mock.patch.object(HARNESS, "_request_json", side_effect=request), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = HARNESS.execute_harness(backend)
        self.assertEqual(result["created"], True)
        self.assertEqual(result["post"], "PASS")
        self.assertEqual(result["get"], "PASS")
        self.assertEqual(result["side_effects"], "ZERO")
        self.assertEqual(result["invocation_evidence"]["evidence_label"], HARNESS.EVIDENCE_ZERO_MEASURED)
        self.assertEqual(backend.puts, 1)
        self.assertEqual(set(backend.user), {"user_id", "password", "plan", "subscription_status"})
        self.assertEqual(backend.user["plan"], {"S": "light"})
        self.assertEqual(backend.user["subscription_status"], {"S": "active"})
        self.assertNotIn("SHIRONE_STAGING_SESSION_TOKEN", os.environ)
        self.assertNotIn("SESSION_TOKEN_SECRET", os.environ)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual([item[0] for item in calls], ["POST", "GET"])
        self.assertEqual(backend.metrics_checked, 1)
        self.assertEqual(backend.assert_expected_state, backend.side_effect_state())

    def test_existing_exact_user_is_reused_without_write(self):
        backend = FakeBackend(valid_user())
        with mock.patch.object(
            HARNESS,
            "_request_json",
            side_effect=[(503, "READING_ASYNC_PAID_DISABLED"), (404, "READING_STATUS_NOT_FOUND")],
        ):
            result = HARNESS.execute_harness(backend)
        self.assertFalse(result["created"])
        self.assertEqual(backend.puts, 0)

    def test_unexpected_existing_user_fails_before_api(self):
        user = valid_user()
        user["extra"] = {"S": "unexpected"}
        backend = FakeBackend(user)
        with mock.patch.object(HARNESS, "_request_json") as request:
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.execute_harness(backend)
        request.assert_not_called()

    def test_existing_password_hash_must_be_modern_well_formed_and_match_fixture(self):
        password_hash, _, _ = HARNESS._lambda_imports()
        malformed_or_wrong = (
            "sha256$600000$c2FsdHNhbHRzYWx0c2FsdA$ZGlnZXN0",
            "pbkdf2_sha256$1$c2FsdHNhbHRzYWx0c2FsdA$ZGlnZXN0",
            "pbkdf2_sha256$600000$bad!base64$ZGlnZXN0",
            "pbkdf2_sha256$600000$c2hvcnQ$ZGlnZXN0",
            "pbkdf2_sha256$600000$c2FsdHNhbHRzYWx0c2FsdA$ZGlnZXN0$extra",
            password_hash("Different-Fixture-Password!", salt=b"0123456789abcdef"),
        )
        for stored_hash in malformed_or_wrong:
            with self.subTest(stored_hash=stored_hash.split("$", 1)[0]):
                user = valid_user()
                user["password"] = {"S": stored_hash}
                backend = FakeBackend(user)
                with mock.patch.object(HARNESS, "_request_json") as request:
                    with self.assertRaises(HARNESS.HarnessError):
                        HARNESS.execute_harness(backend)
                request.assert_not_called()

    def test_post_mismatch_stops_before_get_and_token_is_removed(self):
        backend = FakeBackend(valid_user())
        with mock.patch.object(HARNESS, "_request_json", return_value=(401, "AUTH_TOKEN_INVALID")) as request:
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.execute_harness(backend)
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("SHIRONE_STAGING_SESSION_TOKEN", os.environ)

    def test_get_mismatch_fails_closed(self):
        backend = FakeBackend(valid_user())
        with mock.patch.object(
            HARNESS,
            "_request_json",
            side_effect=[(503, "READING_ASYNC_PAID_DISABLED"), (200, "UNEXPECTED")],
        ) as request:
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.execute_harness(backend)
        self.assertEqual(request.call_count, 2)
        self.assertNotIn("SHIRONE_STAGING_SESSION_TOKEN", os.environ)

    def test_side_effect_delta_fails_closed(self):
        backend = FakeBackend(valid_user())

        def request(*args, **kwargs):
            method = args[1]
            if method == "GET":
                backend.changed = True
                return 404, "READING_STATUS_NOT_FOUND"
            return 503, "READING_ASYNC_PAID_DISABLED"

        with mock.patch.object(HARNESS, "_request_json", side_effect=request):
            with self.assertRaises(HARNESS.HarnessError):
                HARNESS.execute_harness(backend)


if __name__ == "__main__":
    unittest.main()
