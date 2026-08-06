import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?production-membership=${Date.now()}`);
const secret = "fixture-production-session-secret-at-least-32-characters";

function token(userId, exp = 1_900_000_000) {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1_700_000_000, exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function event(overrides = {}) {
  return {
    version: "2.0",
    routeKey: "GET /membership/status",
    rawPath: "/production/membership/status",
    headers: { origin: "https://www.nana-fortune.com", authorization: `Bearer ${token("member@example.invalid")}` },
    requestContext: { requestId: "production-membership-001", http: { method: "GET" } },
    ...overrides,
  };
}

const canonicalLight = {
  plan: "light",
  subscription_status: "active",
  deep_enabled: false,
  monthly_voice_limit: 3,
  monthly_voice_used: 0,
  extra_voice_remaining: 0,
  cancel_at_period_end: false,
  current_period_start: "2026-08-01T00:00:00.000Z",
  current_period_end: "2026-09-01T00:00:00.000Z",
  membership_version: 1,
  membership_schema_version: "shirone-membership-v1",
  membership_source: "manual",
  membership_updated_at: "2026-08-01T00:00:00.000Z",
};

function runtime(record = canonicalLight, overrides = {}) {
  let userReads = 0;
  let quotaReads = 0;
  let secretReads = 0;
  const handler = api.createMembershipStatusHandler({
    enabled: overrides.enabled ?? true,
    allowedOrigins: new Set(["https://www.nana-fortune.com", "https://nana-fortune.com"]),
    disabledErrorCode: "MEMBERSHIP_STATUS_DISABLED",
    auditEvent: "membership_status_rejected",
    requireCanonicalMembership: true,
  }, {
    repository: { async findMembershipByUserId(userId) { userReads += 1; assert.equal(userId, "member@example.invalid"); return record; } },
    quotaRepository: { async readBalances(input) {
      quotaReads += 1;
      assert.equal(input.userId, "member@example.invalid");
      assert.equal(input.membership.plan, "light");
      return { light_monthly_limit: 5, light_monthly_used: 1, light_monthly_remaining: 4, deep_monthly_limit: 0, deep_monthly_used: 0, deep_monthly_remaining: 0 };
    } },
    async getSessionSecret() { secretReads += 1; return secret; },
    auditSink() {},
  });
  return { handler, counts: () => ({ userReads, quotaReads, secretReads }) };
}

test("production membership returns owner-scoped canonical status and quota balances", async () => {
  const app = runtime();
  const response = await app.handler(event());
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.plan, "light");
  assert.equal(body.subscription_status, "active");
  assert.equal(body.light_monthly_limit, 5);
  assert.equal(body.light_monthly_remaining, 4);
  assert.equal("user_id" in body, false);
  assert.deepEqual(app.counts(), { userReads: 1, quotaReads: 1, secretReads: 1 });
});

test("production membership accepts a named-stage rawPath only when routeKey is canonical", async () => {
  const ok = runtime();
  assert.equal((await ok.handler(event({ rawPath: "/production/membership/status" }))).statusCode, 200);
  const bad = runtime();
  const response = await bad.handler(event({ rawPath: "/membership/status", routeKey: "GET /other" }));
  assert.equal(response.statusCode, 404);
  assert.deepEqual(bad.counts(), { userReads: 0, quotaReads: 0, secretReads: 0 });
});

test("production membership accepts both canonical public host origins", async () => {
  const apex = runtime();
  assert.equal((await apex.handler(event({
    headers: { origin: "https://nana-fortune.com", authorization: `Bearer ${token("member@example.invalid")}` },
  }))).statusCode, 200);
  const foreign = runtime();
  assert.equal((await foreign.handler(event({
    headers: { origin: "https://example.invalid", authorization: `Bearer ${token("member@example.invalid")}` },
  }))).statusCode, 403);
  assert.deepEqual(foreign.counts(), { userReads: 0, quotaReads: 0, secretReads: 0 });
});

test("production membership is disabled before reading secrets or DynamoDB", async () => {
  const app = runtime(canonicalLight, { enabled: false });
  const response = await app.handler(event());
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, "MEMBERSHIP_STATUS_DISABLED");
  assert.deepEqual(app.counts(), { userReads: 0, quotaReads: 0, secretReads: 0 });
});

test("production membership rejects non-canonical records without exposing identity", async () => {
  const app = runtime({ plan: "light", subscription_status: "active" });
  const response = await app.handler(event());
  assert.equal(response.statusCode, 503);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "MEMBERSHIP_STATE_INVALID");
  assert.equal(response.body.includes("member@example.invalid"), false);
  assert.deepEqual(app.counts(), { userReads: 1, quotaReads: 0, secretReads: 1 });
});

test("production membership rejects missing Bearer without reading DynamoDB", async () => {
  const app = runtime();
  const response = await app.handler(event({ headers: { origin: "https://www.nana-fortune.com" } }));
  assert.equal(response.statusCode, 401);
  assert.deepEqual(app.counts(), { userReads: 0, quotaReads: 0, secretReads: 1 });
});
