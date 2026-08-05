import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

await build({ entryPoints: ["src/server/fincode/index.ts"], outfile: "dist/fincode-membership-quota-test/index.mjs", bundle: true,
  packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent" });
await build({ entryPoints: ["src/server/readingServerFoundation.ts"], outfile: "dist/reading-membership-quota-test/index.mjs", bundle: true,
  packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent" });
const fincode = await import(`${new URL("../dist/fincode-membership-quota-test/index.mjs", import.meta.url).href}?v=${Date.now()}`);
const reading = await import(`${new URL("../dist/reading-membership-quota-test/index.mjs", import.meta.url).href}?v=${Date.now()}`);

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";
const PERIOD_ID = fincode.createFincodePeriodId(START, END);
const REQUEST = "a".repeat(64);
const OTHER_REQUEST = "b".repeat(64);
const NOW = new Date("2026-08-15T00:00:00.000Z");

function membership(plan = "light", overrides = {}) {
  const policy = plan === "premium"
    ? { subscription_status: "active", deep_enabled: true, monthly_voice_limit: 10 }
    : plan === "light"
      ? { subscription_status: "active", deep_enabled: false, monthly_voice_limit: 3 }
      : { subscription_status: "inactive", deep_enabled: false, monthly_voice_limit: 0 };
  return {
    membership_schema_version: "shirone-membership-v1", plan, ...policy, monthly_voice_used: 1, extra_voice_remaining: 2,
    cancel_at_period_end: false, current_period_start: plan === "free" ? null : START, current_period_end: plan === "free" ? null : END,
    membership_version: 2, membership_source: "fincode_direct", membership_updated_at: "2026-07-30T00:00:00.000Z", ...overrides,
  };
}

function quota(plan = "light", overrides = {}) {
  const limit = reading.getLightQuotaLimit(plan);
  return {
    quotaRef: reading.createLightQuotaRef({ userId: "fixture_user", periodId: PERIOD_ID }), periodId: PERIOD_ID,
    periodStart: START, periodEnd: END, plan, limit, used: 0, reservations: [], completedRequestRefs: [], version: 1,
    membershipVersion: 2, createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: 1_800_000_000, ...overrides,
  };
}

function common(item, requestRef = REQUEST) {
  return { tableName: "light-quota-staging", item, userId: "fixture_user", periodId: PERIOD_ID,
    membership: { plan: item?.plan ?? "light", subscriptionStatus: "active", currentPeriodStart: START, currentPeriodEnd: END, version: 2 },
    mode: "light", requestRef, now: NOW };
}

test("membership v1 accepts free, active light, and active premium policy", () => {
  for (const plan of ["free", "light", "premium"]) {
    const parsed = fincode.parseFincodeMembershipRecordV1(membership(plan));
    assert.equal(parsed.plan, plan);
    assert.equal(parsed.extraVoiceRemaining, 2);
  }
});

test("membership timestamps accept only UTC Z or +00:00 and canonicalize to Z", () => {
  const canonical = fincode.parseFincodeMembershipRecordV1(membership("free", {
    membership_updated_at: "2026-07-30T00:00:00+00:00",
  }));
  assert.equal(canonical.membershipUpdatedAt, "2026-07-30T00:00:00.000Z");
  assert.equal(
    fincode.parseFincodeMembershipRecordV1(membership("free", {
      membership_updated_at: "2026-07-30T00:00:00.123456+00:00",
    })).membershipUpdatedAt,
    "2026-07-30T00:00:00.123456Z",
  );
  assert.equal(
    fincode.parseFincodeMembershipRecordV1(membership("light", {
      current_period_start: "2026-08-01T00:00:00+00:00",
      current_period_end: "2026-09-01T00:00:00+00:00",
    })).currentPeriodStart,
    START,
  );
  for (const invalid of [
    "2026-07-30T00:00:00",
    "2026-07-30",
    "2026-07-30T00:00:00+09:00",
    "2026-02-30T00:00:00Z",
    "2026-07-30T00:00:00.1Z",
    "2026-07-30T00:00:00.1234Z",
  ]) assert.equal(fincode.parseFincodeMembershipRecordV1(membership("free", { membership_updated_at: invalid })), null);
});

test("free inactive legacy NULL period is accepted while paid or mixed NULL period fails closed", () => {
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("free")).currentPeriodStart, null);
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("light", { current_period_start: null, current_period_end: null })), null);
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("free", { current_period_start: START, current_period_end: null })), null);
});

test("membership v1 rejects unknown plan/status, invalid policy, and legacy shape", () => {
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("enterprise")), null);
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("light", { subscription_status: "unknown" })), null);
  assert.equal(fincode.parseFincodeMembershipRecordV1(membership("light", { deep_enabled: true })), null);
  assert.equal(fincode.parseFincodeMembershipRecordV1({ plan: "light" }), null);
});

test("membership transition distinguishes activation, same/new period, incomplete, cancel, and plan change", () => {
  const current = fincode.parseFincodeMembershipRecordV1(membership("light"));
  const period = { periodStart: START, periodEnd: END };
  assert.equal(fincode.decideFincodeMembershipTransition({ current: null, targetPlan: "light", providerStatus: "ACTIVE", period }), "ACTIVATE");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "light", providerStatus: "RUNNING", period }), "SAME_PERIOD_UPDATE");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "light", providerStatus: "RUNNING", period: { periodStart: END, periodEnd: "2026-10-01T00:00:00.000Z" } }), "NEW_PERIOD_RENEWAL");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "premium", providerStatus: "ACTIVE", period }), "PLAN_CHANGE_MANUAL_REVIEW");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "light", providerStatus: "INCOMPLETE" }), "INCOMPLETE_EXISTING");
  assert.equal(fincode.decideFincodeMembershipTransition({ current: null, targetPlan: "light", providerStatus: "INCOMPLETE" }), "INCOMPLETE_NEW");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "light", providerStatus: "CANCELED" }), "CANCEL_SCHEDULED");
  assert.equal(fincode.decideFincodeMembershipTransition({ current, targetPlan: "light", providerStatus: "ACTIVE" }), "REJECT");
});

test("period ID is deterministic UTC interval identity and rejects inferred/invalid periods", () => {
  assert.equal(fincode.createFincodePeriodId(START, END), PERIOD_ID);
  assert.notEqual(fincode.createFincodePeriodId(END, "2026-10-01T00:00:00.000Z"), PERIOD_ID);
  for (const [start, end] of [[END, START], ["2026/08/01", END], [START, START]]) {
    assert.throws(() => fincode.createFincodePeriodId(start, end), /FINCODE_PERIOD_INVALID/);
  }
});

test("trusted period result requires exact canonical shape and matching period digest", () => {
  const valid = { status: "RESOLVED", periodId: PERIOD_ID, periodStart: START, periodEnd: END, source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1" };
  assert.deepEqual(fincode.validateFincodeSubscriptionPeriodResult(valid), valid);
  assert.equal(fincode.validateFincodeSubscriptionPeriodResult({ ...valid, periodId: "f".repeat(64) }), null);
  assert.equal(fincode.validateFincodeSubscriptionPeriodResult({ ...valid, receivedAt: START }), null);
  assert.deepEqual(fincode.validateFincodeSubscriptionPeriodResult({ status: "NOT_AVAILABLE" }), { status: "NOT_AVAILABLE" });
});

test("static period source never derives a period from processDate or delivery time", async () => {
  const source = new fincode.StaticFincodeSubscriptionPeriodSource(new Map());
  const input = { environment: "staging", subscriptionReference: "subscription_fixture", subscriptionDigest: "c".repeat(64),
    customerReference: "stg_customer_fixture_000000000000", customerDigest: "d".repeat(64), planReference: "plan_fixture", plan: "light",
    eventType: "subscription.card.regist", processDate: "2099/12/31 23:59:59.999" };
  assert.deepEqual(await source.resolve(input), { status: "NOT_AVAILABLE" });
});

test("light quota limits and references are deterministic and mode-separated", () => {
  assert.equal(reading.getLightQuotaLimit("free"), 0);
  assert.equal(reading.getLightQuotaLimit("light"), 5);
  assert.equal(reading.getLightQuotaLimit("premium"), 20);
  assert.equal(reading.createLightQuotaRef({ userId: "fixture_user", periodId: PERIOD_ID }), quota().quotaRef);
  assert.notEqual(reading.createLightQuotaRef({ userId: "fixture_user", periodId: "e".repeat(64) }), quota().quotaRef);
});

test("light reserve creates a versioned conditional action without resetting used", () => {
  const item = quota("light", { used: 2 });
  const result = reading.reserveLightQuota({ ...common(item), historyId: "history-1", reservationId: "reservation-1", reservationSeconds: 600 });
  assert.equal(result.status, "RESERVED");
  assert.equal(result.next.used, 2);
  assert.equal(result.next.reservations.length, 1);
  assert.match(result.action.Put.ConditionExpression, /#version = :expectedVersion/);
  assert.equal(result.action.Put.ExpressionAttributeValues[":membershipVersion"].N, "2");
});

test("light reserve is duplicate-safe, bounded, and expires stale reservations lazily", () => {
  const existing = { requestRef: REQUEST, historyId: "history", reservationId: "reservation", reservedAt: NOW.toISOString(), expiresAt: 1_800_000_000 };
  assert.equal(reading.reserveLightQuota({ ...common(quota("light", { reservations: [existing] })), historyId: "history", reservationId: "new", reservationSeconds: 600 }).status, "DUPLICATE_RESERVED");
  const full = quota("light", { used: 5 });
  assert.equal(reading.reserveLightQuota({ ...common(full), historyId: "history", reservationId: "new", reservationSeconds: 600 }).status, "LIMIT_REACHED");
  const stale = { ...existing, requestRef: OTHER_REQUEST, expiresAt: 1 };
  const result = reading.reserveLightQuota({ ...common(quota("light", { used: 4, reservations: [stale] })), historyId: "history", reservationId: "new", reservationSeconds: 600 });
  assert.equal(result.status, "RESERVED");
  assert.equal(result.next.reservations.some((entry) => entry.requestRef === OTHER_REQUEST), false);
});

test("light complete consumes exactly once and duplicate complete does not emit another action", () => {
  const reservation = { requestRef: REQUEST, historyId: "history", reservationId: "reservation", reservedAt: NOW.toISOString(), expiresAt: 1_800_000_000 };
  const completed = reading.completeLightQuota({ ...common(quota("light", { reservations: [reservation] })), reservationId: "reservation" });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.next.used, 1);
  assert.equal(completed.next.reservations.length, 0);
  assert.equal(reading.completeLightQuota({ ...common(completed.next), reservationId: "reservation" }).status, "DUPLICATE_COMPLETED");
});

test("light release removes only its reservation and never increments used", () => {
  const reservation = { requestRef: REQUEST, historyId: "history", reservationId: "reservation", reservedAt: NOW.toISOString(), expiresAt: 1_800_000_000 };
  const released = reading.releaseLightQuota({ ...common(quota("light", { used: 2, reservations: [reservation] })), reservationId: "reservation" });
  assert.equal(released.status, "RELEASED");
  assert.equal(released.next.used, 2);
  assert.equal(reading.releaseLightQuota({ ...common(released.next), reservationId: "reservation" }).status, "ALREADY_RELEASED");
});

test("light lifecycle fails closed for free/deep, missing item, wrong period, or membership version", () => {
  for (const override of [
    { mode: "free" }, { mode: "deep" }, { item: null }, { periodId: "e".repeat(64) },
    { membership: { plan: "light", subscriptionStatus: "active", currentPeriodStart: START, currentPeriodEnd: END, version: 3 } },
    { membership: { plan: "premium", subscriptionStatus: "active", currentPeriodStart: START, currentPeriodEnd: END, version: 2 } },
    { membership: { plan: "light", subscriptionStatus: "inactive", currentPeriodStart: START, currentPeriodEnd: END, version: 2 } },
  ]) assert.throws(() => reading.reserveLightQuota({ ...common(quota()), ...override, historyId: "history", reservationId: "reservation", reservationSeconds: 600 }), /READING_LIGHT_QUOTA/);
});

test("reviewed Webhook factory creates new-period allowance, verifies same-period quota, and blocks unresolved period", () => {
  const factory = fincode.createReviewedWebhookCompletionPlanFactory(new Map([["provider-light", "light"]]));
  const event = { status: "ACTIVE", planRef: "provider-light" };
  const trustedPeriod = { periodId: PERIOD_ID, periodStart: START, periodEnd: END, source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1" };
  const inactive = { version: 1, plan: "free", subscriptionStatus: "inactive", currentPeriodStart: null, currentPeriodEnd: null };
  const created = factory({ event, membershipSnapshot: inactive, decision: "ACTIVATE_SUBSCRIPTION", trustedPeriod });
  assert.equal(created.quotaMutation.kind, "CREATE_PERIOD_ALLOWANCE");
  assert.equal(factory({ event, membershipSnapshot: inactive, decision: "ACTIVATE_SUBSCRIPTION" }), null);
  const active = { version: 2, plan: "light", subscriptionStatus: "active", currentPeriodStart: START, currentPeriodEnd: END };
  const verified = factory({ event, membershipSnapshot: active, decision: "UPDATE_SUBSCRIPTION", trustedPeriod });
  assert.equal(verified.entitlementMutation.kind, "VERIFY_MEMBERSHIP");
  assert.equal(verified.quotaMutation.kind, "VERIFY_PERIOD_ALLOWANCE");
});

test("plan change and INCOMPLETE generate no quota grant or entitlement mutation", () => {
  const factory = fincode.createReviewedWebhookCompletionPlanFactory(new Map([["provider-premium", "premium"]]));
  const active = { version: 2, plan: "light", subscriptionStatus: "active", currentPeriodStart: START, currentPeriodEnd: END };
  const period = { periodId: PERIOD_ID, periodStart: START, periodEnd: END, source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1" };
  const changed = factory({ event: { status: "ACTIVE", planRef: "provider-premium" }, membershipSnapshot: active, decision: "UPDATE_SUBSCRIPTION", trustedPeriod: period });
  assert.equal(changed.finalLedgerState, "MANUAL_REVIEW");
  assert.equal(changed.quotaMutation.kind, "NONE");
  const incomplete = factory({ event: { status: "INCOMPLETE", planRef: "provider-premium" }, membershipSnapshot: active, decision: "RECORD_INCOMPLETE" });
  assert.equal(incomplete.quotaMutation.kind, "NONE");
  assert.equal(incomplete.entitlementMutation.kind, "NONE");
});
