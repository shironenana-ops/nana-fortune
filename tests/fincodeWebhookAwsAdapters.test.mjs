import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const output = "dist/fincode-webhook-aws-test/index.mjs";
await build({ entryPoints: ["src/server/fincode/index.ts"], outfile: output, bundle: true, platform: "node", format: "esm",
  packages: "external", target: "node22", logLevel: "silent" });
const api = await import(`${new URL(`../${output}`, import.meta.url).href}?v=${Date.now()}`);

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";
const PERIOD_ID = api.createFincodePeriodId(PERIOD_START, PERIOD_END);
const baseEnv = {
  FINCODE_WEBHOOK_ENVIRONMENT: "staging",
  FINCODE_WEBHOOK_SIGNATURE_SECRET_ENVIRONMENT: "staging",
  FINCODE_WEBHOOK_ENABLED: "true",
  FINCODE_WEBHOOK_LEDGER_TABLE: "ledger-staging",
  FINCODE_CUSTOMER_MAPPING_TABLE: "mapping-staging",
  USERS_TABLE_NAME: "users-staging",
  READING_DEEP_QUOTA_TABLE_NAME: "deep-quota-staging",
  FINCODE_MEMBERSHIP_QUOTA_TABLE: "light-quota-staging",
  FINCODE_WEBHOOK_SIGNATURE_SECRET_ID: "staging/fincode/webhook-signature",
  FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS: "90",
  FINCODE_WEBHOOK_SECRET_CACHE_TTL_SECONDS: "300",
  FINCODE_WEBHOOK_ALLOWED_SHOP_DIGESTS: DIGEST_A,
  FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING: '{"plan_light":"light","plan_premium":"premium"}',
  FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION: "shirone-membership-v1",
};

test("AWS config is explicit and mutation stays closed without both reviewed schemas", () => {
  const ready = api.readFincodeWebhookAwsConfig(baseEnv);
  assert.equal(ready.mutationAvailable, true);
  assert.equal(api.readFincodeWebhookAwsConfig({ ...baseEnv, FINCODE_WEBHOOK_ENABLED: "false" }).mutationAvailable, false);
  assert.equal(api.readFincodeWebhookAwsConfig({ ...baseEnv, FINCODE_MEMBERSHIP_QUOTA_TABLE: "" }).mutationAvailable, false);
  assert.equal(api.readFincodeWebhookAwsConfig({ ...baseEnv, FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION: undefined }).mutationAvailable, false);
  for (const invalid of [
    { FINCODE_WEBHOOK_ENVIRONMENT: "production" },
    { FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS: "29" },
    { FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS: "731" },
    { FINCODE_WEBHOOK_SECRET_CACHE_TTL_SECONDS: "0" },
    { FINCODE_WEBHOOK_ALLOWED_SHOP_DIGESTS: "raw-shop-id" },
    { FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING: '{"plan":"free"}' },
    { FINCODE_WEBHOOK_ENABLED: "1" },
  ]) assert.throws(() => api.readFincodeWebhookAwsConfig({ ...baseEnv, ...invalid }), /FINCODE_WEBHOOK_AWS_CONFIG_INVALID/);
});

test("ledger reserve writes digest-only item and classifies duplicates", async () => {
  const commands = [];
  const ledger = new api.DynamoFincodeWebhookLedger({ send: async (command) => { commands.push(command); return {}; } }, "ledger-staging", "staging", () => 1_700_000_000_000);
  assert.equal(await ledger.reserve({ semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, ttlSeconds: 3600 }), "RESERVED");
  assert.equal(commands[0].constructor.name, "PutItemCommand");
  assert.deepEqual(Object.keys(commands[0].input.Item).sort(), ["attempt_count", "created_at", "environment", "event_digest", "expires_at", "payload_fingerprint", "processing_state", "result_code", "updated_at", "version"]);
  assert.match(commands[0].input.ConditionExpression, /attribute_not_exists/);

  let count = 0;
  const duplicate = new api.DynamoFincodeWebhookLedger({ send: async (command) => {
    if (count++ === 0) { const error = new Error("hidden"); error.name = "ConditionalCheckFailedException"; throw error; }
    return { Item: { event_digest: { S: DIGEST_A }, payload_fingerprint: { S: DIGEST_B }, environment: { S: "staging" }, processing_state: { S: "COMPLETED" } } };
  } }, "ledger-staging", "staging");
  assert.equal(await duplicate.reserve({ semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, ttlSeconds: 60 }), "DUPLICATE_COMPLETED");
});

test("ledger retryable failure is conditional and uses only a fixed safe error", async () => {
  let command;
  const ledger = new api.DynamoFincodeWebhookLedger({ send: async (value) => { command = value; return {}; } }, "ledger-staging", "staging");
  await ledger.fail({ semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, retryableResultCode: "CUSTOMER_LOOKUP_UNAVAILABLE" });
  assert.equal(command.constructor.name, "UpdateItemCommand");
  assert.match(command.input.ConditionExpression, /processing_state/);
  await assert.rejects(() => ledger.fail({ semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, retryableResultCode: "unsafe detail" }), /FINCODE_WEBHOOK_LEDGER_UNAVAILABLE/);
});

test("ledger rejects a fingerprint collision without overwriting the existing event", async () => {
  let count = 0;
  const ledger = new api.DynamoFincodeWebhookLedger({ send: async () => {
    if (count++ === 0) { const error = new Error("hidden"); error.name = "ConditionalCheckFailedException"; throw error; }
    return { Item: { payload_fingerprint: { S: "f".repeat(64) }, environment: { S: "staging" }, processing_state: { S: "RESERVED" } } };
  } }, "ledger-staging", "staging");
  assert.equal(await ledger.reserve({ semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, ttlSeconds: 60 }), "CONFLICT");
});

test("customer mapping hashes the opaque reference and uses two consistent GetItem calls", async () => {
  const commands = [];
  const client = { send: async (command) => {
    commands.push(command);
    return commands.length === 1 ? { Item: {
      customer_ref_digest: { S: DIGEST_A }, internal_user_id: { S: "staging_fixture_user" }, environment: { S: "staging" },
      mapping_status: { S: "ACTIVE" }, version: { N: "1" },
    } } : { Item: {
      user_id: { S: "staging_fixture_user" }, membership_schema_version: { S: "shirone-membership-v1" }, membership_version: { N: "2" }, plan: { S: "light" },
      subscription_status: { S: "active" }, current_period_start: { S: PERIOD_START }, current_period_end: { S: PERIOD_END },
      deep_enabled: { BOOL: false }, monthly_voice_limit: { N: "3" }, monthly_voice_used: { N: "1" }, extra_voice_remaining: { N: "2" },
      cancel_at_period_end: { BOOL: false }, membership_source: { S: "fincode_direct" }, membership_updated_at: { S: "2026-07-30T00:00:00.000Z" },
    } };
  } };
  const mapping = new api.DynamoFincodeCustomerMapping(client, "mapping-staging", "users-staging", "staging");
  const result = await mapping.findByOpaqueCustomerReference("opaque_customer_ref");
  assert.equal(result.status, "FOUND");
  assert.equal(commands.length, 2);
  assert.equal(commands[0].constructor.name, "GetItemCommand");
  assert.equal(commands[0].input.ConsistentRead, true);
  assert.notEqual(commands[0].input.Key.customer_ref_digest.S, "opaque_customer_ref");
  assert.equal(commands.some((command) => /Scan|Query/.test(command.constructor.name)), false);
});

test("customer mapping distinguishes missing mapping and rejects environment mismatch", async () => {
  const missing = new api.DynamoFincodeCustomerMapping({ send: async () => ({}) }, "mapping-staging", "users-staging", "staging");
  assert.deepEqual(await missing.findByOpaqueCustomerReference("opaque"), { status: "NOT_FOUND" });
  const mismatch = new api.DynamoFincodeCustomerMapping({ send: async () => ({ Item: {
    internal_user_id: { S: "fixture_user" }, environment: { S: "production" }, mapping_status: { S: "ACTIVE" }, version: { N: "1" },
  } }) }, "mapping-staging", "users-staging", "staging");
  assert.deepEqual(await mismatch.findByOpaqueCustomerReference("opaque"), { status: "CONFLICT" });
});

test("customer mapping fails closed for legacy paid membership without a trusted period", async () => {
  let call = 0;
  const client = { send: async () => call++ === 0 ? { Item: {
    internal_user_id: { S: "fixture_user" }, environment: { S: "staging" }, mapping_status: { S: "ACTIVE" }, version: { N: "1" },
  } } : { Item: {
    user_id: { S: "fixture_user" }, membership_schema_version: { S: "shirone-membership-v1" }, membership_version: { N: "1" },
    plan: { S: "light" }, subscription_status: { S: "active" }, deep_enabled: { BOOL: false }, monthly_voice_limit: { N: "3" },
    monthly_voice_used: { N: "0" }, extra_voice_remaining: { N: "0" }, cancel_at_period_end: { BOOL: false },
    membership_source: { S: "legacy_migration" }, membership_updated_at: { S: "2026-07-30T00:00:00.000Z" },
  } } };
  const mapping = new api.DynamoFincodeCustomerMapping(client, "mapping-staging", "users-staging", "staging");
  assert.deepEqual(await mapping.findByOpaqueCustomerReference("opaque"), { status: "CONFLICT" });
});

test("signature adapter caches one secret and never exposes provider failures", async () => {
  let calls = 0;
  const signature = new api.SecretsManagerFincodeWebhookSignature({ send: async () => { calls += 1; return { SecretString: '{"fincode_webhook_signature":"fixture-signature"}' }; } }, "secret-id", 60, () => 1000);
  assert.equal(await signature.getExpectedSignature(), "fixture-signature");
  assert.equal(await signature.getExpectedSignature(), "fixture-signature");
  assert.equal(calls, 1);
  const failed = new api.SecretsManagerFincodeWebhookSignature({ send: async () => { throw new Error("provider request and secret detail"); } }, "secret-id", 60);
  await assert.rejects(() => failed.getExpectedSignature(), (error) => error.message === "FINCODE_WEBHOOK_SECRET_UNAVAILABLE" && !error.message.includes("provider"));
});

test("signature adapter rejects malformed JSON, binary values, and extra JSON keys", async () => {
  for (const response of [
    { SecretString: "{" },
    { SecretBinary: new Uint8Array([1, 2, 3]) },
    { SecretString: '{"fincode_webhook_signature":"fixture","extra":"denied"}' },
  ]) {
    const adapter = new api.SecretsManagerFincodeWebhookSignature({ send: async () => response }, "secret-id", 60);
    await assert.rejects(() => adapter.getExpectedSignature(), /FINCODE_WEBHOOK_SECRET_UNAVAILABLE/);
  }
});

function completionRequest() {
  return {
    semanticEventKey: DIGEST_A, payloadFingerprint: DIGEST_B, expectedLedgerState: "RESERVED", userReference: "staging_fixture_user",
    normalizedEvent: { environment: "staging", eventType: "subscription.card.regist", status: "ACTIVE" },
    correlationDigest: "c".repeat(64), retentionTtlSeconds: 7_776_000, completedAt: "2026-07-30T00:00:00.000Z",
    completionPlan: {
      decision: "ACTIVATE_SUBSCRIPTION", expectedMembership: { version: 1, plan: "free", subscriptionStatus: "inactive", currentPeriodStart: null, currentPeriodEnd: null },
      plan: "light", finalLedgerState: "COMPLETED", period: { source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1", periodId: PERIOD_ID, periodStart: PERIOD_START, periodEnd: PERIOD_END },
      entitlementMutation: { kind: "SET_MEMBERSHIP", plan: "light", subscriptionStatus: "active", deepEnabled: false, monthlyVoiceLimit: 3, cancelAtPeriodEnd: false },
      quotaMutation: { kind: "CREATE_PERIOD_ALLOWANCE", periodId: PERIOD_ID, lightLimit: 5, preserveExistingUsage: true },
      billingMutation: { kind: "NONE" }, resultCode: "ENTITLEMENT_APPLIED", ledgerOnly: false,
    },
  };
}

test("atomic completion emits exactly one bounded transaction with all three conditional mutations", async () => {
  let command;
  const config = api.readFincodeWebhookAwsConfig(baseEnv);
  const adapter = new api.DynamoFincodeAtomicCompletion({ send: async (value) => { command = value; return {}; } }, config);
  assert.equal(await adapter.applyAndComplete(completionRequest()), "COMPLETED");
  assert.equal(command.constructor.name, "TransactWriteItemsCommand");
  assert.equal(command.input.TransactItems.length, 3);
  assert.equal(command.input.TransactItems.filter((item) => item.Update?.TableName === "users-staging").length, 1);
  assert.equal(command.input.TransactItems.filter((item) => item.Put?.TableName === "light-quota-staging").length, 1);
  assert.equal(command.input.TransactItems.filter((item) => item.Update?.TableName === "ledger-staging").length, 1);
  const serialized = JSON.stringify(command.input);
  assert.equal(serialized.includes("deep-quota-staging"), false);
  assert.equal(serialized.includes("monthly_voice_used"), false);
  assert.equal(serialized.includes("extra_voice_remaining"), false);
  assert.match(serialized, /attribute_not_exists\(quota_ref\)/);
  assert.equal(command.input.ClientRequestToken.length, 36);
});

test("same-period atomic completion condition-checks membership and quota without resetting usage or limit", async () => {
  let command;
  const config = api.readFincodeWebhookAwsConfig(baseEnv);
  const request = completionRequest();
  request.completionPlan = {
    decision: "UPDATE_SUBSCRIPTION",
    expectedMembership: { version: 2, plan: "light", subscriptionStatus: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END },
    plan: "light", finalLedgerState: "COMPLETED", period: request.completionPlan.period,
    entitlementMutation: { kind: "VERIFY_MEMBERSHIP" },
    quotaMutation: { kind: "VERIFY_PERIOD_ALLOWANCE", periodId: PERIOD_ID, expectedLimit: 5, preserveExistingUsage: true },
    billingMutation: { kind: "NONE" }, resultCode: "WEBHOOK_COMPLETED", ledgerOnly: false,
  };
  const adapter = new api.DynamoFincodeAtomicCompletion({ send: async (value) => { command = value; return {}; } }, config);
  assert.equal(await adapter.applyAndComplete(request), "COMPLETED");
  assert.equal(command.input.TransactItems.length, 3);
  assert.equal(command.input.TransactItems.filter((item) => item.ConditionCheck?.TableName === "users-staging").length, 1);
  assert.equal(command.input.TransactItems.filter((item) => item.ConditionCheck?.TableName === "light-quota-staging").length, 1);
  assert.equal(command.input.TransactItems.filter((item) => item.Update?.TableName === "ledger-staging").length, 1);
  const serialized = JSON.stringify(command.input);
  assert.equal(serialized.includes("used"), false);
  assert.equal(serialized.includes("reservations"), false);
  assert.equal(serialized.includes("monthly_voice_used"), false);
  assert.equal(serialized.includes("extra_voice_remaining"), false);
});

test("atomic completion and composition fail closed without reviewed schema or trusted period", async () => {
  let sends = 0;
  const blockedConfig = api.readFincodeWebhookAwsConfig({ ...baseEnv, FINCODE_MEMBERSHIP_QUOTA_TABLE: "" });
  const adapter = new api.DynamoFincodeAtomicCompletion({ send: async () => { sends += 1; return {}; } }, blockedConfig);
  assert.equal(await adapter.applyAndComplete(completionRequest()), "UNAVAILABLE");
  assert.equal(sends, 0);
  const composed = api.createFincodeWebhookAwsAdapters(blockedConfig, { dynamodb: { send: async () => { throw new Error("network"); } }, secretsManager: { send: async () => { throw new Error("network"); } } });
  assert.equal(composed.atomicCompletion, undefined);
  assert.equal(composed.completionPlanFactory, undefined);
  const factory = api.createFailClosedWebhookCompletionPlanFactory();
  const active = factory({ event: { status: "ACTIVE" }, membershipSnapshot: { version: 1, plan: "free", subscriptionStatus: "inactive", currentPeriodStart: null, currentPeriodEnd: null }, decision: "ACTIVATE_SUBSCRIPTION" });
  assert.equal(active, null);
});

test("atomic completion maps transaction conditions and ambiguous completed delivery safely", async () => {
  const config = api.readFincodeWebhookAwsConfig(baseEnv);
  const conflict = new api.DynamoFincodeAtomicCompletion({ send: async () => {
    const error = new Error("internal condition detail"); error.name = "TransactionCanceledException";
    error.CancellationReasons = [{ Code: "ConditionalCheckFailed" }]; throw error;
  } }, config);
  assert.equal(await conflict.applyAndComplete(completionRequest()), "CONDITIONAL_CONFLICT");

  let calls = 0;
  const recovered = new api.DynamoFincodeAtomicCompletion({ send: async () => {
    if (calls++ === 0) throw new Error("provider detail");
    return { Item: { payload_fingerprint: { S: DIGEST_B }, processing_state: { S: "COMPLETED" }, result_code: { S: "ENTITLEMENT_APPLIED" } } };
  } }, config);
  assert.equal(await recovered.applyAndComplete(completionRequest()), "ALREADY_COMPLETED");
});

test("AWS adapter source has no top-level client construction or outbound request implementation", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/server/fincode/aws/dynamoWebhookLedger.ts", "src/server/fincode/aws/dynamoCustomerMapping.ts",
    "src/server/fincode/aws/dynamoAtomicCompletion.ts", "src/server/fincode/aws/secretsWebhookSignature.ts",
    "src/server/fincode/aws/createWebhookAwsAdapters.ts",
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /new\s+(?:DynamoDBClient|SecretsManagerClient)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest)\s*\(/u);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/u);
});
