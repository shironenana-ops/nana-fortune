import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?staging-membership=${Date.now()}`);
const secret = "fixture-session-secret-at-least-32-characters";

function token(userId, exp = 1_900_000_000) {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1_700_000_000, exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function event(overrides = {}) {
  return {
    version: "2.0",
    routeKey: "GET /membership/status",
    rawPath: "/staging/membership/status",
    headers: { origin: "http://127.0.0.1:4321", authorization: `Bearer ${token("member@staging.invalid")}` },
    requestContext: { requestId: "request-fixture-001", http: { method: "GET" } },
    ...overrides,
  };
}

function handler(record, overrides = {}) {
  let secretReads = 0;
  let requestedUser = null;
  const app = api.createStagingMembershipStatusHandler(
    { enabled: overrides.enabled ?? true, allowedOrigins: api.LOCAL_STAGING_ORIGINS },
    {
      repository: { async findMembershipByUserId(userId) { requestedUser = userId; return record; } },
      async getSessionSecret() { secretReads += 1; return secret; },
      auditSink() {},
    },
  );
  return { app, get secretReads() { return secretReads; }, get requestedUser() { return requestedUser; } };
}

test("owner sessionだけからfree/light/premium会員状態を返す", async () => {
  for (const fixture of [
    { plan: "free", subscription_status: "inactive" },
    { plan: "light", subscription_status: "active" },
    { plan: "premium", subscription_status: "active", deep_enabled: true, monthly_voice_limit: 10, monthly_voice_used: 2 },
  ]) {
    const runtime = handler(fixture);
    const response = await runtime.app(event());
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.plan, fixture.plan);
    assert.equal(runtime.requestedUser, "member@staging.invalid");
    assert.equal("user_id" in body, false);
  }
});

test("missing/invalid/expired Bearerとquery user_idをfail closedで拒否する", async () => {
  const cases = [
    event({ headers: { origin: "http://127.0.0.1:4321" } }),
    event({ headers: { origin: "http://127.0.0.1:4321", authorization: "Bearer invalid" } }),
    event({ headers: { origin: "http://127.0.0.1:4321", authorization: `Bearer ${token("member@staging.invalid", 1)}` } }),
    event({ queryStringParameters: { user_id: "other@staging.invalid" } }),
  ];
  for (const request of cases) {
    const runtime = handler({ plan: "premium" });
    const response = await runtime.app(request);
    assert.notEqual(response.statusCode, 200);
    assert.equal(runtime.requestedUser, null);
  }
});

test("disabled flagはSecretとDynamoDBに触れず503", async () => {
  const runtime = handler({ plan: "premium" }, { enabled: false });
  const response = await runtime.app(event());
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, "STAGING_MEMBERSHIP_STATUS_DISABLED");
  assert.equal(runtime.secretReads, 0);
  assert.equal(runtime.requestedUser, null);
});

test("routeKeyを正としnamed stage rawPathを許容、別routeとunknown originを拒否する", async () => {
  const ok = handler({ plan: "free" });
  assert.equal((await ok.app(event())).statusCode, 200);
  const badRoute = handler({ plan: "free" });
  assert.equal((await badRoute.app(event({ routeKey: "GET /other", rawPath: "/membership/status" }))).statusCode, 404);
  const badOrigin = handler({ plan: "free" });
  assert.equal((await badOrigin.app(event({ headers: { origin: "https://example.com", authorization: `Bearer ${token("member@staging.invalid")}` } }))).statusCode, 403);
});

test("runtime Secret adapterはexact staging ARNとsession keyだけを受け入れる", async () => {
  const arn = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:shirone7/staging/runtime-AbCd";
  const client = { async send() { return { SecretString: JSON.stringify({ session_token_secret: secret, unrelated: "not-returned" }) }; } };
  assert.equal(await api.loadStagingSessionSecret({ secretArn: arn, client }), secret);
  await assert.rejects(() => api.loadStagingSessionSecret({ secretArn: arn.replace("staging", "production"), client }), /STAGING_AUTH_NOT_CONFIGURED/u);
  await assert.rejects(() => api.loadStagingSessionSecret({ secretArn: arn, client: { async send() { return { SecretString: "{}" }; } } }), /STAGING_AUTH_NOT_CONFIGURED/u);
  assert.equal(api.assertStagingTableName("nana-reading-staging-users"), "nana-reading-staging-users");
  assert.throws(() => api.assertStagingTableName("nana-reading-production-users"), /STAGING_AUTH_NOT_CONFIGURED/u);
});
