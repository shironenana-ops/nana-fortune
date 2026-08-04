import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

await build({ entryPoints: ["src/server/fincode/index.ts"], outfile: "dist/canonical-fincode-test/index.mjs", bundle: true,
  packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent" });
await build({ entryPoints: ["src/server/readingServerFoundation.ts"], outfile: "dist/canonical-reading-test/index.mjs", bundle: true,
  packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent" });
const fincode = await import(`${new URL("../dist/canonical-fincode-test/index.mjs", import.meta.url).href}?v=${Date.now()}`);
const reading = await import(`${new URL("../dist/canonical-reading-test/index.mjs", import.meta.url).href}?v=${Date.now()}`);

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";
const NOW = "2026-08-03T00:00:00.000Z";

function legacy(plan, overrides = {}) {
  return {
    plan,
    subscription_status: plan === "free" ? "inactive" : "active",
    deep_enabled: plan === "premium",
    monthly_voice_limit: plan === "premium" ? 10 : plan === "light" ? 3 : 0,
    monthly_voice_used: 0,
    extra_voice_remaining: 0,
    current_period_end: END,
    ...overrides,
  };
}

test("legacy free membership becomes canonical without inventing a contract period", () => {
  const result = fincode.planLegacyUserCanonicalMigration({ item: legacy("free"), now: NOW });
  assert.equal(result.status, "MIGRATABLE");
  assert.equal(result.update.membership_schema_version, "shirone-membership-v1");
  assert.equal("current_period_start" in result.update, false);
  assert.equal("current_period_end" in result.update, false);
});

test("paid legacy membership fails closed without a trusted contract period", () => {
  for (const plan of ["light", "premium"]) {
    assert.deepEqual(fincode.planLegacyUserCanonicalMigration({ item: legacy(plan), now: NOW }),
      { status: "MANUAL_REVIEW", reason: "TRUSTED_CONTRACT_PERIOD_REQUIRED" });
  }
});

test("trusted paid migration preserves usage and produces membership-v1", () => {
  const result = fincode.planLegacyUserCanonicalMigration({ item: legacy("light", { monthly_voice_used: 2, extra_voice_remaining: 4 }),
    trustedPeriod: { periodStart: START, periodEnd: END }, now: NOW });
  assert.equal(result.status, "MIGRATABLE");
  assert.equal(result.update.monthly_voice_used, 2);
  assert.equal(result.update.extra_voice_remaining, 4);
  assert.ok(fincode.parseFincodeMembershipRecordV1(result.update));
});

test("legacy quota drift requires human review instead of clamping or resetting", () => {
  assert.deepEqual(fincode.planLegacyUserCanonicalMigration({ item: legacy("premium", { monthly_voice_used: 42, monthly_voice_limit: 100 }),
    trustedPeriod: { periodStart: START, periodEnd: END }, now: NOW }),
    { status: "MANUAL_REVIEW", reason: "LEGACY_MONTHLY_USAGE_EXCEEDS_CANONICAL_LIMIT" });
});

test("history migration emits metadata-only update and unknown generation fails closed", () => {
  const ready = fincode.planLegacyHistoryCanonicalMigration({ status: "completed", source: "legacy_voice", created_at: NOW, updated_at: NOW,
    resolved_mode: "light", reading_date: "2026-08-03", public_result: "fixture-result", private_body: "not copied" });
  assert.equal(ready.status, "MIGRATABLE");
  assert.equal("private_body" in ready.update, false);
  assert.equal(fincode.planLegacyHistoryCanonicalMigration({ status: "mystery", source: "legacy", created_at: NOW, updated_at: NOW }).status, "MANUAL_REVIEW");
});

test("legacy quota policy never clamps and separates migratable, review, blocked, and unknown", () => {
  assert.equal(fincode.classifyLegacyQuotaMigration({ plan: "light", used: 2, legacyLimit: 3, periodStatus: "RESOLVED" }).status, "MIGRATABLE");
  assert.equal(fincode.classifyLegacyQuotaMigration({ plan: "premium", used: 42, legacyLimit: 100, periodStatus: "RESOLVED" }).status, "MANUAL_REVIEW");
  assert.equal(fincode.classifyLegacyQuotaMigration({ plan: "light", used: 1, legacyLimit: 3, periodStatus: "CONFLICT" }).status, "BLOCKED");
  assert.equal(fincode.classifyLegacyQuotaMigration({ plan: "light", used: -1, legacyLimit: 3, periodStatus: "RESOLVED" }).status, "UNKNOWN_SCHEMA");
});

test("observed legacy readiness isolates paid records without an anchor and unknown history", () => {
  const users = [legacy("free"), legacy("light"), legacy("premium"), legacy("premium"), legacy("premium")];
  const decisions = users.map((item) => fincode.planLegacyUserCanonicalMigration({ item, now: NOW }));
  assert.deepEqual(decisions.map((value) => value.status), ["MIGRATABLE", "MANUAL_REVIEW", "MANUAL_REVIEW", "MANUAL_REVIEW", "MANUAL_REVIEW"]);
  const history = fincode.planLegacyHistoryCanonicalMigration({ status: "completed", source: "legacy", created_at: NOW, updated_at: NOW });
  assert.equal(history.status, "MANUAL_REVIEW");
});

test("staging-equivalent fixture remains deterministic and rerun safe", () => {
  const input = { item: legacy("light", { monthly_voice_used: 1 }), trustedPeriod: { periodStart: START, periodEnd: END }, now: NOW };
  const first = fincode.planLegacyUserCanonicalMigration(input);
  const second = fincode.planLegacyUserCanonicalMigration(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "MIGRATABLE");
  assert.equal(fincode.planLegacyUserCanonicalMigration({ item: first.update, trustedPeriod: input.trustedPeriod, now: NOW }).status, "NO_OP");
});

test("migration rerun is a no-op", () => {
  const canonical = { ...legacy("light"), membership_schema_version: "shirone-membership-v1", membership_version: 1,
    membership_source: "legacy_migration", membership_updated_at: NOW, current_period_start: START, current_period_end: END,
    cancel_at_period_end: false };
  assert.equal(fincode.planLegacyUserCanonicalMigration({ item: canonical, trustedPeriod: { periodStart: START, periodEnd: END }, now: NOW }).status, "NO_OP");
});

test("Voice consumes monthly allowance before one-time extra balance", () => {
  const base = { plan: "premium", subscriptionStatus: "active", monthlyVoiceLimit: 10, monthlyVoiceUsed: 9, extraVoiceRemaining: 2 };
  assert.equal(reading.decideCanonicalVoiceConsumption(base), "MONTHLY");
  assert.equal(reading.decideCanonicalVoiceConsumption({ ...base, monthlyVoiceUsed: 10 }), "EXTRA");
});

test("free and inactive members can consume only a purchased extra balance", () => {
  assert.equal(reading.decideCanonicalVoiceConsumption({ plan: "free", subscriptionStatus: "inactive", monthlyVoiceLimit: 0, monthlyVoiceUsed: 0, extraVoiceRemaining: 1 }), "EXTRA");
  assert.equal(reading.decideCanonicalVoiceConsumption({ plan: "premium", subscriptionStatus: "inactive", monthlyVoiceLimit: 10, monthlyVoiceUsed: 0, extraVoiceRemaining: 0 }), "LIMIT_REACHED");
});

test("Voice completion is one Users plus one History atomic transaction", () => {
  const actions = reading.buildCanonicalVoiceCompletionTransaction({ usersTableName: "canonical-users", historyTableName: "canonical-history",
    userId: "fixture-user", historyId: "fixture-history", eventRef: "a".repeat(64), resultLocation: "result/opaque.json", completedAt: NOW,
    balance: { plan: "light", subscriptionStatus: "active", monthlyVoiceLimit: 3, monthlyVoiceUsed: 1, extraVoiceRemaining: 2 } });
  assert.equal(actions.length, 2);
  assert.match(actions[0].Update.UpdateExpression, /monthly_voice_used/);
  assert.match(actions[1].Update.ConditionExpression, /attribute_not_exists\(voice_event_ref\)/);
  assert.match(actions[1].Update.UpdateExpression, /voice_event_ref/);
});

test("Voice extra completion is bounded by the observed balance", () => {
  const actions = reading.buildCanonicalVoiceCompletionTransaction({ usersTableName: "canonical-users", historyTableName: "canonical-history",
    userId: "fixture-user", historyId: "fixture-history", eventRef: "b".repeat(64), resultLocation: "result/opaque.json", completedAt: NOW,
    balance: { plan: "free", subscriptionStatus: "inactive", monthlyVoiceLimit: 0, monthlyVoiceUsed: 0, extraVoiceRemaining: 1 } });
  assert.match(actions[0].Update.UpdateExpression, /extra_voice_remaining/);
  assert.equal(actions[0].Update.ExpressionAttributeValues[":extra"].N, "1");
});

test("Voice quota zero and malformed event references fail closed", () => {
  assert.throws(() => reading.buildCanonicalVoiceCompletionTransaction({ usersTableName: "canonical-users", historyTableName: "canonical-history",
    userId: "fixture-user", historyId: "fixture-history", eventRef: "bad", resultLocation: "result/opaque.json", completedAt: NOW,
    balance: { plan: "free", subscriptionStatus: "inactive", monthlyVoiceLimit: 0, monthlyVoiceUsed: 0, extraVoiceRemaining: 0 } }), /CANONICAL_VOICE_COMPLETION_INVALID/);
});

test("Light and Deep use the same contract-period identity", () => {
  assert.equal(reading.createDeepContractPeriodKey(START, END), fincode.createFincodePeriodId(START, END));
});

test("canonical modules contain no network, storage, or secret retrieval path", async () => {
  const source = await Promise.all([
    readFile("src/server/fincode/canonicalMigration.ts", "utf8"),
    readFile("src/server/voice/canonicalVoiceConsumption.ts", "utf8"),
  ]).then((parts) => parts.join("\n"));
  assert.doesNotMatch(source, /fetch\(|GetSecretValue|localStorage|sessionStorage|https?:\/\//u);
});
