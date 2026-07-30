import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const output = "dist/fincode-webhook-lambda-test/index.mjs";
await build({ entryPoints: ["src/server/fincode/index.ts"], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", target: "node22", logLevel: "silent" });
const api = await import(`${new URL(`../${output}`, import.meta.url).href}?v=${Date.now()}`);

const env = {
  FINCODE_WEBHOOK_ENABLED: "false", FINCODE_PERIOD_SOURCE_ENABLED: "false", FINCODE_WEBHOOK_ENVIRONMENT: "staging",
  FINCODE_WEBHOOK_SIGNATURE_SECRET_ENVIRONMENT: "staging", FINCODE_WEBHOOK_LEDGER_TABLE: "ledger-staging",
  FINCODE_CUSTOMER_MAPPING_TABLE: "mapping-staging", FINCODE_MEMBERSHIP_QUOTA_TABLE: "quota-staging",
  USERS_TABLE_NAME: "users-staging", READING_DEEP_QUOTA_TABLE_NAME: "deep-staging", FINCODE_WEBHOOK_SIGNATURE_SECRET_ID: "secret-staging",
  FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS: "180", FINCODE_WEBHOOK_SECRET_CACHE_TTL_SECONDS: "300",
  FINCODE_WEBHOOK_ALLOWED_SHOP_DIGESTS: "a".repeat(64), FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING: '{"light_plan":"light"}',
  FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION: "shirone-membership-v1", FINCODE_CUSTOMER_REFERENCE_PREFIX: "stg_customer_",
  FINCODE_WEBHOOK_INTERNAL_DEADLINE_MS: "2500",
};

test("disabled Lambda returns fixed retry without AWS adapter calls", async () => {
  let calls = 0;
  const handler = api.createFincodeWebhookLambda({ env, dynamodb: { async send() { calls++; } }, secretsManager: { async send() { calls++; } } });
  assert.deepEqual(await handler({}), { statusCode: 503, headers: { "content-type": "application/json" }, body: '{"receive":"1"}' });
  assert.equal(calls, 0);
});

test("missing signature fails closed before DynamoDB and does not expose internals", async () => {
  let dynamoCalls = 0;
  const handler = api.createFincodeWebhookLambda({ env: { ...env, FINCODE_WEBHOOK_ENABLED: "true" }, dynamodb: { async send() { dynamoCalls++; throw new Error("raw-secret"); } }, secretsManager: { async send() { throw new Error("raw-secret"); } } });
  const response = await handler({});
  assert.equal(response.statusCode, 503);
  assert.equal(response.body, '{"receive":"1"}');
  assert.doesNotMatch(JSON.stringify(response), /raw-secret/u);
  assert.equal(dynamoCalls, 0);
});

test("period source is disabled by default in reviewed config", () => {
  const config = api.readFincodeWebhookAwsConfig(env);
  assert.equal(config.periodSourceEnabled, false);
  assert.equal(config.internalDeadlineMs, 2500);
});

test("membership migration is staging-only, explicit and period-gated", async () => {
  const proposed = {
    membership_schema_version: "shirone-membership-v1", plan: "light", subscription_status: "active", deep_enabled: false,
    monthly_voice_limit: 3, monthly_voice_used: 2, extra_voice_remaining: 4, cancel_at_period_end: false,
    current_period_start: "2026-08-01T00:00:00.000Z", current_period_end: "2026-09-01T00:00:00.000Z",
    membership_version: 2, membership_source: "legacy_migration", membership_updated_at: "2026-07-30T00:00:00.000Z",
  };
  await assert.rejects(() => api.planFincodeMembershipMigration({ environment: "production", candidates: [{ targetRef: "fixture_user_01", current: {}, proposed }], allowedTargetRefs: new Set(["fixture_user_01"]) }), /PRODUCTION_DENIED/u);
  const manual = await api.planFincodeMembershipMigration({ environment: "staging", candidates: [{ targetRef: "fixture_user_01", current: {}, proposed }], allowedTargetRefs: new Set(["fixture_user_01"]) });
  assert.equal(manual[0].status, "MANUAL_REVIEW");
  const ready = await api.planFincodeMembershipMigration({ environment: "staging", candidates: [{ targetRef: "fixture_user_01", current: {}, proposed, trustedPeriod: { periodStart: proposed.current_period_start, periodEnd: proposed.current_period_end } }], allowedTargetRefs: new Set(["fixture_user_01"]) });
  assert.equal(ready[0].status, "READY");
  assert.doesNotMatch(JSON.stringify(ready), /fixture_user_01/u);
});
