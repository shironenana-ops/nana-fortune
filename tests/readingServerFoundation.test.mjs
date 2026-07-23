import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

const buildResult = await buildReadingFoundation();
const artifactUrl = new URL("../dist/reading-server-foundation/index.mjs", import.meta.url);
const foundation = await import(`${artifactUrl.href}?test=${Date.now()}`);
const TEST_SECRET = "fixture-only-session-secret-not-for-production";
const AUDIT_SECRET = "fixture-only-audit-secret-not-for-production";
const NOW = 2_000_000_000;
const python = "C:\\Users\\kokur\\AppData\\Local\\Python\\bin\\python.exe";
const pythonFixture = fileURLToPath(new URL("./fixtures/session_token_compat.py", import.meta.url));

function encode(value) {
  return Buffer.from(value).toString("base64url");
}
function createToken(payload, secret = TEST_SECRET) {
  const part = encode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(part).digest("base64url");
  return `${part}.${signature}`;
}
function validPayload(overrides = {}) {
  return { user_id: "fixture-user-001", iat: NOW - 10, exp: NOW + 3600, ...overrides };
}
function runPython(request) {
  const result = spawnSync(python, [pythonFixture], { input: JSON.stringify(request), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("AuthorizationはPython互換の厳密なBearer形式だけを受理する", () => {
  const token = createToken(validPayload());
  assert.equal(foundation.parseAuthorizationHeader({ authorization: `Bearer ${token}` }), token);
  assert.equal(foundation.parseAuthorizationHeader({ AUTHORIZATION: `Bearer  ${token}  ` }), token);
  for (const headers of [
    {}, { authorization: "" }, { authorization: "Basic abc" }, { authorization: "bearer abc" },
    { authorization: "Bearer " }, { authorization: ["Bearer a", "Bearer b"] },
    { authorization: "Bearer a\nb" }, { authorization: `Bearer ${"a".repeat(4097)}` },
  ]) assert.throws(() => foundation.parseAuthorizationHeader(headers));
});

test("Python生成tokenをNodeが受理し、Node互換tokenをPythonが受理する", () => {
  const payload = validPayload({ exp: 4_000_000_000 });
  const pythonToken = runPython({ action: "create", payload, secret: TEST_SECRET });
  assert.deepEqual(foundation.verifySessionToken({ token: pythonToken, secret: TEST_SECRET, nowEpochSeconds: NOW }), payload);
  const nodeToken = createToken(payload);
  assert.deepEqual(JSON.parse(runPython({ action: "verify", token: nodeToken, secret: TEST_SECRET })), { valid: true });
});

test("不正token・payload・期限・secret不足を拒否し、未来iatはPython互換で受理する", () => {
  const base = createToken(validPayload());
  for (const token of [
    `${base.slice(0, -1)}x`, `${base}x`, "abc", "a.b.c", "%%%.abc",
    createToken(validPayload({ user_id: "" })), createToken(validPayload({ user_id: 7 })),
    createToken(validPayload({ exp: NOW - 1 })), createToken(validPayload({ iat: "bad" })),
  ]) assert.throws(() => foundation.verifySessionToken({ token, secret: TEST_SECRET, nowEpochSeconds: NOW }));
  assert.throws(() => foundation.verifySessionToken({ token: base, secret: "different", nowEpochSeconds: NOW }));
  assert.throws(() => foundation.verifySessionToken({ token: base, secret: "", nowEpochSeconds: NOW }));
  assert.equal(foundation.verifySessionToken({ token: createToken(validPayload({ iat: NOW + 999999 })), secret: TEST_SECRET, nowEpochSeconds: NOW }).user_id, "fixture-user-001");
});

test("Dynamo repositoryはtoken由来キーとProjectionだけを使いwhitelistする", async () => {
  let command;
  const client = { send: async (value) => {
    command = value;
    return { Item: {
      plan: { S: "premium" }, subscription_status: { S: "active" }, deep_enabled: { BOOL: true },
      monthly_voice_limit: { N: "10" }, monthly_voice_used: { N: "3" }, extra_voice_remaining: { N: "2" },
      password: { S: "must-not-escape" }, stripe_customer_email: { S: "hidden-email-value" }, unknown: { S: "hidden" },
    } };
  } };
  const repository = new foundation.DynamoUserRepository(client, "fixture-users");
  const result = await repository.findMembershipByUserId("fixture-user-001");
  assert.equal(command.input.Key.user_id.S, "fixture-user-001");
  assert.match(command.input.ProjectionExpression, /#plan/);
  assert.deepEqual(Object.keys(result).sort(), ["cancel_at_period_end","current_period_end","deep_enabled","extra_voice_remaining","monthly_voice_limit","monthly_voice_used","plan","subscription_status"].sort());
  assert.equal("password" in result, false);
  assert.equal("stripe_customer_email" in result, false);
  assert.throws(() => new foundation.DynamoUserRepository(client, ""));
  assert.equal(await new foundation.DynamoUserRepository({ send: async () => ({}) }, "users").findMembershipByUserId("x"), null);
  await assert.rejects(() => new foundation.DynamoUserRepository({ send: async () => { throw new Error("aws detail"); } }, "users").findMembershipByUserId("x"), /USER_STORE_UNAVAILABLE/);
});

test("会員コンテキストは既存entitlementsを再利用し公開要約へuserIdを出さない", async () => {
  const repository = { findMembershipByUserId: async () => ({
    plan: "premium", subscription_status: "active", deep_enabled: true,
    monthly_voice_limit: 5, monthly_voice_used: 8, extra_voice_remaining: -1,
  }) };
  const context = await foundation.loadAuthenticatedMembershipContext({ session: validPayload(), repository });
  assert.equal(context.userId, "fixture-user-001");
  assert.equal(context.entitlements.canUseDeep, true);
  assert.equal(context.entitlements.monthlyVoiceRemaining, 0);
  const publicValue = foundation.toPublicMembershipSummary(context);
  assert.equal("userId" in publicValue, false);
  assert.equal("membership" in publicValue, false);
  await assert.rejects(() => foundation.loadAuthenticatedMembershipContext({ session: validPayload(), repository: { findMembershipByUserId: async () => null } }), /USER_NOT_FOUND/);
});

test("CORSは完全一致allow-listだけを返しpreflightを制限する", () => {
  const origin = "https://fixture.example";
  const allowedOrigins = foundation.parseAllowedOrigins(origin);
  const accepted = foundation.evaluateCors({ origin, allowedOrigins, method: "OPTIONS", requestedHeaders: "Authorization, Idempotency-Key, Content-Type" });
  assert.equal(accepted.headers["Access-Control-Allow-Origin"], origin);
  assert.equal(accepted.headers.Vary, "Origin");
  assert.equal(foundation.evaluateCors({ allowedOrigins }).allowed, true);
  for (const attack of [
    "https://fixture.example.evil.invalid", "https://evil.invalid/?https://fixture.example", "http://fixture.example",
    "https://fixture.example:444", "https://FIXTURE.example", "https://fixture.example/", "https://user@fixture.example",
    "null", "", "*", "https://fixture.example\nX: y",
  ]) assert.throws(() => foundation.evaluateCors({ origin: attack, allowedOrigins }));
  assert.throws(() => foundation.parseAllowedOrigins(undefined));
  assert.throws(() => foundation.parseAllowedOrigins("*"));
  assert.throws(() => foundation.evaluateCors({ origin, allowedOrigins, method: "DELETE" }));
  assert.throws(() => foundation.evaluateCors({ origin, allowedOrigins, method: "OPTIONS", requestedHeaders: "X-Anything" }));
});

test("共通エラーは固定messageとrequest_idだけを返す", () => {
  const response = foundation.toSafeErrorResponse(new foundation.ServerFoundationError("USER_STORE_UNAVAILABLE", { cause: new Error("secret aws request id") }), "req-safe-001");
  assert.equal(response.status, 503);
  assert.deepEqual(Object.keys(response.body.error), ["code", "message", "request_id"]);
  assert.doesNotMatch(JSON.stringify(response), /secret|aws request|stack|user_id|token/i);
  assert.equal(foundation.toSafeErrorResponse(new Error("password token"), "req-safe-002").body.error.code, "INTERNAL_ERROR");
});

test("request_idと監査ログはPIIを含まず構造化1行になる", () => {
  assert.match(foundation.createRequestId(), /^[0-9a-f-]{36}$/);
  assert.equal(foundation.createRequestId("client-request-001"), "client-request-001");
  assert.notEqual(foundation.createRequestId("bad\nid"), "bad\nid");
  assert.notEqual(foundation.createRequestId("x".repeat(200)), "x".repeat(200));
  const lines = [];
  const first = foundation.writeSafeAuditLog({ event: { requestId: "req-001", event: "auth\ncheck", outcome: "success", membershipPlan: "premium" }, userId: "fixture-user-001", auditHashSecret: AUDIT_SECRET, sink: (line) => lines.push(line), now: new Date("2026-01-01T00:00:00Z") });
  const second = foundation.writeSafeAuditLog({ event: { requestId: "req-001", event: "auth", outcome: "success" }, userId: "fixture-user-001", auditHashSecret: AUDIT_SECRET, sink: () => {} });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\n|fixture-user|Authorization|password|birth|question/i);
  assert.deepEqual(JSON.parse(lines[0]), first);
  assert.equal(first.user_ref, second.user_ref);
  assert.notEqual(first.user_ref, foundation.createAuditUserRef("fixture-user-002", AUDIT_SECRET));
  assert.notEqual(first.user_ref, foundation.createAuditUserRef("fixture-user-001", "another-audit-secret"));
  assert.equal(foundation.createAuditUserRef("fixture-user-001", undefined), undefined);
});

test("foundation bundleはNode専用で実AWS接続なしにimportできる", () => {
  const inputs = Object.keys(buildResult.metafile.inputs).join("\n");
  assert.match(inputs, /membershipEntitlements\.ts/);
  const artifact = fs.readFileSync(artifactUrl, "utf8");
  assert.doesNotMatch(artifact, /\b(?:window|document)\s*(?:\.|\[)|\b(?:localStorage|sessionStorage|navigator|DOMParser)\b|astro\/client|@vite\/client/i);
  assert.doesNotMatch(artifact, /PUBLIC_/);
  assert.doesNotMatch(artifact, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_/);
});
