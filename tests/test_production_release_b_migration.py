import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "apply_production_release_b_migration.py"
SPEC = importlib.util.spec_from_file_location("release_b_migration", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ReleaseBMigrationContractTests(unittest.TestCase):
    def test_manifest_is_exactly_five_and_fixed(self):
        self.assertEqual(len(MODULE.TARGETS), 5)
        self.assertEqual(MODULE.PERIOD_START, "2026-07-31T15:00:00.000Z")
        self.assertEqual(MODULE.PERIOD_END, "2026-08-31T15:00:00.000Z")
        self.assertEqual(sum(item["light"] for item in MODULE.TARGETS.values()), 65)
        self.assertEqual(sum(item["deep"] for item in MODULE.TARGETS.values()), 9)
        self.assertEqual(sum(item["voice"] for item in MODULE.TARGETS.values()), 33)

    def test_targets_are_nonrenewing_and_payment_free(self):
        now = "2026-08-06T00:00:00.000Z"
        for target in MODULE.TARGETS.values():
            canonical = MODULE._canonical_target(target, now)
            self.assertFalse(canonical["automatic_renewal"])
            self.assertEqual(canonical["extra_voice_remaining"], 0)
            self.assertNotIn("payment_id", canonical)
            self.assertNotIn("subscription_id", canonical)

    def test_runtime_secret_is_resolved_from_exact_operator_policy(self):
        arn = MODULE._runtime_secret_arn_from_policy()
        self.assertTrue(arn.startswith(f"arn:aws:secretsmanager:{MODULE.REGION}:{MODULE.ACCOUNT}:secret:shirone7/production/runtime-"))
        self.assertNotIn("staging", arn.lower())

    def test_operator_policy_limits_writes_to_transaction_enclosed_item_actions(self):
        policy = __import__("json").loads(MODULE.OPERATOR_POLICY.read_text(encoding="utf-8"))
        statements = {item["Sid"]: item for item in policy["Statement"]}
        membership = statements["ApplyConditionalCanonicalMembershipUpdate"]
        quotas = statements["ApplyConditionalCanonicalQuotaCreates"]
        self.assertEqual(membership["Action"], "dynamodb:UpdateItem")
        self.assertEqual(quotas["Action"], "dynamodb:PutItem")
        self.assertEqual(membership["Condition"]["StringEquals"]["dynamodb:EnclosingOperation"], "TransactWriteItems")
        self.assertEqual(quotas["Condition"]["StringEquals"]["dynamodb:EnclosingOperation"], "TransactWriteItems")
        self.assertNotIn("dynamodb:TransactWriteItems", str(policy))

    def test_transaction_updates_only_canonical_membership_and_quota_tables(self):
        context = {"light_table": "prod-light", "deep_table": "prod-deep"}
        item = {
            "user_id": "test@test.com", "plan": "premium", "subscription_status": "active",
            "deep_enabled": True, "monthly_voice_limit": 20, "monthly_voice_used": 2,
            "extra_voice_remaining": 0,
        }
        entry = {"logical": "test@test.com", "user_id": "test@test.com", "item": item, "target": MODULE.TARGETS["test@test.com"]}
        actions = MODULE._transaction(context, entry, "fixture-secret-value-at-least-32-bytes", "2026-08-06T00:00:00.000Z")
        self.assertEqual([next(iter(action.values()))["TableName"] for action in actions], ["shirone7_users", "prod-light", "prod-deep"])
        update = actions[0]["Update"]
        self.assertIn("attribute_not_exists(#schema)", update["ConditionExpression"])
        self.assertNotIn("password", str(update).lower())
        self.assertNotIn("delete", str(actions).lower())


if __name__ == "__main__":
    unittest.main()
