import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const voice = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?voice-reservation=${Date.now()}`);
const NOW = "2026-08-05T00:00:00.000Z";
const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";

const monthly = {
  plan: "light", subscriptionStatus: "active", monthlyVoiceLimit: 3, monthlyVoiceUsed: 1,
  monthlyVoiceReserved: 1, extraVoiceRemaining: 2, extraVoiceReserved: 0,
};

test("voice reservation counts in-flight monthly work before allowing another", () => {
  assert.equal(voice.decideCanonicalVoiceConsumption(monthly), "MONTHLY");
  assert.equal(voice.decideCanonicalVoiceConsumption({ ...monthly, monthlyVoiceUsed: 2 }), "EXTRA");
  assert.equal(voice.decideCanonicalVoiceConsumption({ ...monthly, monthlyVoiceUsed: 2, extraVoiceReserved: 2 }), "LIMIT_REACHED");
});

test("voice monthly reservation atomically reserves Users and creates History", () => {
  const tx = voice.buildCanonicalVoiceReservationTransaction({
    usersTableName: "users", historyTableName: "history", userId: "fixture", historyId: "history-1",
    reservationRef: "a".repeat(64), createdAt: NOW, membershipVersion: 3,
    currentPeriodStart: START, currentPeriodEnd: END, balance: monthly,
  });
  assert.equal(tx.length, 2);
  assert.match(tx[0].Update.UpdateExpression, /monthly_voice_reserved/u);
  assert.match(tx[0].Update.ConditionExpression, /membership_schema_version/u);
  assert.match(tx[0].Update.ConditionExpression, /current_period_start/u);
  assert.equal(tx[1].Put.Item.voice_consumption.S, "monthly");
  assert.match(tx[1].Put.ConditionExpression, /attribute_not_exists/u);
});

test("voice completion consumes exactly one existing reservation", () => {
  const tx = voice.buildCanonicalVoiceReservedCompletionTransaction({
    usersTableName: "users", historyTableName: "history", userId: "fixture", historyId: "history-1",
    reservationRef: "a".repeat(64), completionRef: "b".repeat(64), resultLocation: "result/opaque.json",
    completedAt: NOW, consumption: "monthly",
  });
  assert.match(tx[0].Update.UpdateExpression, /monthly_voice_reserved = monthly_voice_reserved - :one/u);
  assert.match(tx[0].Update.UpdateExpression, /monthly_voice_used = monthly_voice_used \+ :one/u);
  assert.match(tx[1].Update.ConditionExpression, /attribute_not_exists\(voice_completion_ref\)/u);
});

test("voice failure releases its reservation without consuming quota", () => {
  const tx = voice.buildCanonicalVoiceReleaseTransaction({
    usersTableName: "users", historyTableName: "history", userId: "fixture", historyId: "history-1",
    reservationRef: "a".repeat(64), releasedAt: NOW, consumption: "extra", failureCode: "VOICE_PROVIDER_ERROR",
  });
  assert.match(tx[0].Update.UpdateExpression, /extra_voice_reserved = extra_voice_reserved - :one/u);
  assert.doesNotMatch(tx[0].Update.UpdateExpression, /extra_voice_remaining.*-/u);
  assert.equal(tx[1].Update.ExpressionAttributeValues[":failure"].S, "VOICE_PROVIDER_ERROR");
});

test("voice reservation fails closed on missing period and malformed references", () => {
  assert.throws(() => voice.buildCanonicalVoiceReservationTransaction({
    usersTableName: "users", historyTableName: "history", userId: "fixture", historyId: "history-1",
    reservationRef: "bad", createdAt: NOW, membershipVersion: 1, currentPeriodStart: null, currentPeriodEnd: null,
    balance: monthly,
  }), /CANONICAL_VOICE_RESERVATION_INVALID/u);
});
