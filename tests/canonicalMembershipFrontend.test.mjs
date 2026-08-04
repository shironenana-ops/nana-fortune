import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

const members = await readFile("src/pages/members.astro", "utf8");
const premium = await readFile("src/pages/premium.astro", "utf8");
const source = `${members}\n${premium}`;
await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?membership=${Date.now()}`);
const secret = "fixture-session-secret-at-least-32-characters-long";
function token(userId) {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1_700_000_000, exp: 1_900_000_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

test("membership pages no longer hard-code the legacy public API", () => {
  assert.doesNotMatch(source, /zaebx82pyf|subscription\/change-plan/u);
  assert.match(source, /PUBLIC_CANONICAL_MEMBERSHIP_STATUS_URL/u);
});

test("membership status uses Bearer identity and never sends user_id", () => {
  assert.match(source, /Authorization:\s*`Bearer \$\{authSession\}`/u);
  assert.doesNotMatch(source, /USER_STATUS_(?:API|ENDPOINT).*\?user_id/u);
});

test("legacy client-side plan mutation is fail closed", () => {
  assert.doesNotMatch(members, /fetch\(CHANGE_PLAN_API/u);
  assert.match(members, /プラン変更は安全な会員連携の準備完了まで利用できません/u);
});

test("canonical membership status resolves identity only from the signed session", async () => {
  const requested = [];
  const result = await api.getCanonicalMembershipStatus({
    headers: { Authorization: `Bearer ${token("canonical-user")}` }, sessionSecret: secret, nowEpochSeconds: 1_800_000_000,
    repository: { async findMembershipByUserId(userId) { requested.push(userId); return { plan: "premium", subscription_status: "active", deep_enabled: true, monthly_voice_limit: 10, monthly_voice_used: 2, extra_voice_remaining: 1 }; } },
  });
  assert.deepEqual(requested, ["canonical-user"]);
  assert.equal(result.plan, "premium");
  assert.equal("user_id" in result, false);
});

test("canonical membership status rejects missing or invalid Bearer tokens before lookup", async () => {
  let called = false;
  const repository = { async findMembershipByUserId() { called = true; return null; } };
  await assert.rejects(() => api.getCanonicalMembershipStatus({ headers: {}, sessionSecret: secret, repository }), /AUTH_MISSING/);
  await assert.rejects(() => api.getCanonicalMembershipStatus({ headers: { Authorization: "Bearer invalid" }, sessionSecret: secret, repository }), /AUTH_INVALID_TOKEN/);
  assert.equal(called, false);
});
