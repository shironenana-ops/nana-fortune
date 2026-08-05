import unittest

from scripts.staging_runtime_secret_contract import (
    CANONICAL_KEYS,
    RuntimeSecretContractError,
    assert_secret_boundary,
    canonical_keys_present,
    merge_runtime_secret,
    extract_webhook_signature,
    normalized_webhook_secret,
    resolve_canonical_values,
)


def environments(value="fixture-value"):
    return {
        "ReadingRequestFunction": {
            "SESSION_TOKEN_SECRET": value,
            "AUDIT_HASH_SECRET": value,
            "READING_IDEMPOTENCY_HASH_SECRET": value,
            "READING_DEEP_QUOTA_HASH_SECRET": value,
        },
        "ReadingStatusFunction": {
            "SESSION_TOKEN_SECRET": value,
            "AUDIT_HASH_SECRET": value,
        },
        "LightWorkerFunction": {
            "AUDIT_HASH_SECRET": value,
            "READING_IDEMPOTENCY_HASH_SECRET": value,
        },
        "DeepWorkerFunction": {
            "AUDIT_HASH_SECRET": value,
            "READING_IDEMPOTENCY_HASH_SECRET": value,
            "READING_DEEP_QUOTA_HASH_SECRET": value,
        },
    }


class RuntimeSecretContractTests(unittest.TestCase):
    def test_resolves_only_when_all_consumers_match(self):
        resolved = resolve_canonical_values(environments())
        self.assertEqual(set(resolved), set(CANONICAL_KEYS))

    def test_missing_empty_and_mismatch_fail_closed(self):
        for mutation in ("missing", "empty", "mismatch"):
            fixture = environments()
            if mutation == "missing":
                del fixture["ReadingStatusFunction"]["SESSION_TOKEN_SECRET"]
            elif mutation == "empty":
                fixture["DeepWorkerFunction"]["AUDIT_HASH_SECRET"] = ""
            else:
                fixture["LightWorkerFunction"]["READING_IDEMPOTENCY_HASH_SECRET"] = "different"
            with self.subTest(mutation=mutation):
                with self.assertRaises(RuntimeSecretContractError):
                    resolve_canonical_values(fixture)

    def test_merge_preserves_all_existing_keys(self):
        existing = {
            "fincode_webhook_signature": "fixture-signature",
            "legacy_key": "fixture-legacy",
        }
        canonical = {key: "fixture-canonical" for key in CANONICAL_KEYS}
        merged = merge_runtime_secret(existing, canonical)
        self.assertEqual(merged["fincode_webhook_signature"], "fixture-signature")
        self.assertEqual(merged["legacy_key"], "fixture-legacy")
        self.assertTrue(canonical_keys_present(merged))
        self.assertEqual(existing, {
            "fincode_webhook_signature": "fixture-signature",
            "legacy_key": "fixture-legacy",
        })

    def test_non_object_and_incomplete_merge_fail_closed(self):
        with self.assertRaises(RuntimeSecretContractError):
            merge_runtime_secret([], {key: "fixture" for key in CANONICAL_KEYS})
        with self.assertRaises(RuntimeSecretContractError):
            merge_runtime_secret({}, {CANONICAL_KEYS[0]: "fixture"})

    def test_secret_boundary_requires_distinct_staging_secrets(self):
        account = "123456789012"
        runtime = f"arn:aws:secretsmanager:ap-northeast-1:{account}:secret:shirone7/staging/runtime-AbCdEf"
        webhook = f"arn:aws:secretsmanager:ap-northeast-1:{account}:secret:shirone7/staging/fincode-webhook-signature-GhIjKl"
        assert_secret_boundary(runtime, webhook, account)
        assert_secret_boundary(runtime.replace("staging/", ""), webhook, account)
        for bad_runtime, bad_webhook in (
            (runtime, runtime),
            (runtime.replace("staging", "production"), webhook),
            (runtime.replace(account, "999999999999"), webhook),
            (webhook, runtime),
        ):
            with self.subTest(runtime=bad_runtime, webhook=bad_webhook):
                with self.assertRaises(RuntimeSecretContractError):
                    assert_secret_boundary(bad_runtime, bad_webhook, account)

    def test_webhook_signature_contract_accepts_raw_and_exact_json_only(self):
        self.assertEqual(extract_webhook_signature("fixture-signature")[1], "RAW_STRING")
        self.assertEqual(
            extract_webhook_signature({"fincode_webhook_signature": "fixture-signature"})[1],
            "JSON_EXPECTED_KEY_PRESENT",
        )
        self.assertEqual(
            normalized_webhook_secret("fixture-signature"),
            {"fincode_webhook_signature": "fixture-signature"},
        )
        for invalid in ("", "line\nbreak", {}, {"fincode_webhook_signature": "fixture", "extra": "denied"}):
            with self.subTest(invalid=type(invalid).__name__):
                with self.assertRaises(RuntimeSecretContractError):
                    extract_webhook_signature(invalid)


if __name__ == "__main__":
    unittest.main()
