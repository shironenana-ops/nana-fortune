import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";
import { buildReadingApiHandler } from "../scripts/build-reading-api-handler.mjs";

const [foundationBuild, handlerBuild] = await Promise.all([buildReadingFoundation(), buildReadingApiHandler()]);
const foundation = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?handler=${Date.now()}`);
const SECRET = "fixture-only-session-secret-not-for-production";
const AUDIT_SECRET = "fixture-only-audit-secret-not-for-production";
const ORIGIN = "https://fixture.example";
const KEY = "550e8400-e29b-41d4-a716-446655440000";
const NOW = new Date("2026-07-17T03:00:00.000Z");

function token(userId = "fixture-user-001") {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1_700_000_000, exp: 2_100_000_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
function event(overrides = {}) {
  return {
    version: "2.0",
    rawPath: "/reading/generate",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token()}`,
      "idempotency-key": KEY,
    },
    body: JSON.stringify({ name: "架空 花子", birth_date: "1984-12-29" }),
    isBase64Encoded: false,
    requestContext: { requestId: "gateway-request-001", http: { method: "POST" } },
    ...overrides,
  };
}
function reading(plan = "free") {
  return {
    plan,
    lengthRange: { min: 1, max: 2, label: "hidden" },
    title: "公開タイトル",
    todayMessage: "hidden today",
    marginMessage: "hidden margin",
    oneStep: "公開の一歩",
    avoidHint: "公開の注意",
    audioScript: "hidden audio",
    sections: [{ id: "core", title: "本質", summary: "hidden summary", body: "公開本文" }],
    knowledgePayload: { secret: "hidden knowledge" },
    historyPayloadV2: { secret: "hidden history" },
    iconHints: [{ secret: "hidden icon" }],
    context: { secret: "hidden context" },
    unknownInternal: "must-not-escape",
  };
}
function setup({ enabled = true, membership = {}, repositoryError, rendererMode = "rendered", persistenceKind = "acquired", deepEnabled = true, deepReservation = false } = {}) {
  const calls = { repository: 0, engine: 0, renderer: 0 };
  const audit = [];
  const dependencies = {
    repository: { findMembershipByUserId: async (userId) => {
      calls.repository += 1;
      calls.repositoryUserId = userId;
      if (repositoryError) throw repositoryError;
      return membership === null ? null : membership;
    } },
    clock: { now: () => new Date(NOW) },
    sessionSecret: SECRET,
    auditHashSecret: AUDIT_SECRET,
    auditSink: (line) => audit.push(line),
    idempotencyHashSecret: "fixture-only-idempotency-secret-32-characters-minimum",
    deepEnabled,
    persistence: {
      begin: async ({ requestRef, fingerprint, resolvedMode, readingDate, now }) => persistenceKind === "replay" ? ({ kind: "replay", history: { history_id: "saved-history", created_at: "2026-07-17T00:00:00Z", resolved_mode: "light", status: "completed", rendering_status: "rendered", result: { title: "保存済み", sections: [], one_step: "一歩", avoid_hint: "注意" } } }) : ({ kind: persistenceKind, takeover: false, reservation: { requestRef, fingerprint, ownerToken: "fixture-owner", historyId: "fixture-history", resolvedMode, readingDate, createdAt: now.toISOString(), ...(deepReservation ? { deep: { quotaRef: "q".repeat(64), periodKey: "2026-07", reservationId: "fixture-reservation", reservationExpiresAt: 1_800_000_000 } } : {}) } }),
      complete: async ({ reservation, response }) => { if (persistenceKind === "complete_error") throw new foundation.ServerFoundationError("PERSISTENCE_UNAVAILABLE"); return { history_id: reservation.historyId, created_at: reservation.createdAt, resolved_mode: response.resolved_mode, status: response.status, rendering_status: response.rendering_status, result: response.result }; },
      fail: async () => {},
    },
    engineRunner: (input) => { calls.engine += 1; calls.engineInput = input; return reading(input.plan); },
    renderReading: async ({ reading: canonical }) => {
      calls.renderer += 1;
      if (rendererMode === "throw") throw new Error("raw provider secret");
      return { ...canonical, sections: canonical.sections.map((section) => ({ ...section, body: "整形済み本文" })), rendering: { status: rendererMode, provider: rendererMode === "rendered" ? "bedrock" : "canonical" } };
    },
  };
  const handler = foundation.createReadingApiHandler({ enabled, allowedOrigins: new Set([ORIGIN]) }, dependencies);
  return { handler, calls, audit };
}
function body(response) { return JSON.parse(response.body); }

test("HTTP API v2の許可Origin OPTIONSだけを認証なしで処理する", async () => {
  const { handler, calls } = setup();
  const response = await handler(event({ headers: { origin: ORIGIN, "access-control-request-headers": "Authorization, Content-Type, Idempotency-Key" }, body: undefined, requestContext: { requestId: "gateway-options-001", http: { method: "OPTIONS" } } }));
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(response.headers.Vary, "Origin");
  assert.deepEqual([calls.repository, calls.engine, calls.renderer], [0, 0, 0]);
});

test("不許可Originと紛らわしいOriginは全依存を呼ばず拒否する", async () => {
  for (const origin of ["https://fixture.example.evil.invalid", "http://fixture.example", "https://fixture.example:444", `${ORIGIN}/`]) {
    const { handler, calls } = setup();
    const value = event(); value.headers.origin = origin;
    const response = await handler(value);
    assert.equal(response.statusCode, 403);
    assert.deepEqual([calls.repository, calls.engine, calls.renderer], [0, 0, 0]);
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  }
});

test("OriginなしPOSTはCORS headerなしで認証を必須とする", async () => {
  const { handler } = setup();
  const value = event(); delete value.headers.origin;
  const ok = await handler(value);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["Access-Control-Allow-Origin"], undefined);
  delete value.headers.authorization;
  assert.equal((await handler(value)).statusCode, 401);
});

test("POST以外は405とAllowを返し未知path/v1 eventを拒否する", async () => {
  const { handler, calls } = setup();
  const method = await handler(event({ requestContext: { requestId: "gateway-delete-001", http: { method: "DELETE" } } }));
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.Allow, "POST, OPTIONS");
  assert.equal((await handler(event({ rawPath: "/other" }))).statusCode, 404);
  assert.equal((await handler(event({ version: "1.0" }))).statusCode, 400);
  assert.deepEqual([calls.repository, calls.engine, calls.renderer], [0, 0, 0]);
});

test("kill switchは文字列trueだけ有効で無効時は依存を呼ばない", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true ", "other"]) assert.equal(foundation.readingApiEnabled(value), false);
  assert.equal(foundation.readingApiEnabled("true"), true);
  const { handler, calls } = setup({ enabled: false });
  const response = await handler(event());
  assert.equal(response.statusCode, 503);
  assert.equal(body(response).error.code, "READING_API_DISABLED");
  assert.deepEqual([calls.repository, calls.engine, calls.renderer], [0, 0, 0]);
});

test("Content-Type、空body、JSON、top-level型を厳格に検証する", async () => {
  for (const contentType of [undefined, "text/plain", "application/jsonp", "application/json; charset=shift_jis", "xapplication/json"]) {
    const { handler } = setup(); const value = event();
    if (contentType === undefined) delete value.headers["content-type"]; else value.headers["content-type"] = contentType;
    assert.equal((await handler(value)).statusCode, 415);
  }
  for (const raw of ["", "{", "[]", "null", '"text"']) {
    const { handler } = setup();
    const response = await handler(event({ body: raw }));
    assert.equal(response.statusCode, 400);
  }
});

test("UTF-8 decoded 16KiBとbase64 encoded 24KiB境界を強制する", async () => {
  const { handler } = setup();
  const oversized = JSON.stringify({ name: "あ".repeat(6000), birth_date: "1984-12-29" });
  assert.ok(Buffer.byteLength(oversized, "utf8") > foundation.READING_BODY_MAX_BYTES);
  assert.equal((await handler(event({ body: oversized }))).statusCode, 413);
  const normal = JSON.stringify({ name: "架空", birth_date: "1984-12-29" });
  assert.equal((await handler(event({ body: Buffer.from(normal).toString("base64"), isBase64Encoded: true }))).statusCode, 200);
  assert.equal((await handler(event({ body: "%%%not-base64%%%", isBase64Encoded: true }))).statusCode, 400);
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]).toString("base64");
  assert.equal((await handler(event({ body: invalidUtf8, isBase64Encoded: true }))).statusCode, 400);
});

test("複数値・改行headerと不正Authorization/Idempotency-Keyをengine前に拒否する", async () => {
  for (const [name, value] of [["authorization", `Bearer ${token()},Bearer ${token()}`], ["idempotency-key", `${KEY},${KEY}`], ["authorization", "Bearer bad\nvalue"]]) {
    const { handler, calls } = setup(); const input = event(); input.headers[name] = value;
    const response = await handler(input);
    assert.ok([400, 401].includes(response.statusCode));
    assert.equal(calls.engine, 0);
  }
  const { handler, calls } = setup(); const input = event(); input.headers["idempotency-key"] = "not-uuid";
  assert.equal((await handler(input)).statusCode, 400);
  assert.equal(calls.engine, 0);
});

test("bodyのuser_idと特権fieldを拒否しtoken由来user_idだけをRepositoryへ渡す", async () => {
  const { handler, calls } = setup();
  const bad = await handler(event({ body: JSON.stringify({ name: "架空", birth_date: "1984-12-29", user_id: "attacker", plan: "deep" }) }));
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.repositoryUserId, "fixture-user-001");
  assert.equal(calls.engine, 0);
});

test("user不存在とstore障害は安全な固定エラーへ変換する", async () => {
  assert.equal((await setup({ membership: null }).handler(event())).statusCode, 404);
  const unavailable = new foundation.ServerFoundationError("USER_STORE_UNAVAILABLE", { cause: new Error("AWS request secret") });
  const response = await setup({ repositoryError: unavailable }).handler(event());
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /AWS|secret|stack|fixture-user/i);
});

test("free/light/premium標準modeとdeep明示権利を既存resolverで処理する", async () => {
  const cases = [
    [{}, undefined, "free"],
    [{ plan: "light", subscription_status: "active" }, undefined, "light"],
    [{ plan: "premium", subscription_status: "active", deep_enabled: true }, undefined, "light"],
    [{ plan: "premium", subscription_status: "active", deep_enabled: true }, "deep", "deep"],
  ];
  for (const [membership, requested, expected] of cases) {
    const { handler, calls } = setup({ membership });
    const payload = { name: "架空", birth_date: "1984-12-29", ...(requested ? { requested_mode: requested } : {}) };
    const response = await handler(event({ body: JSON.stringify(payload) }));
    assert.equal(response.statusCode, 200);
    assert.equal(body(response).resolved_mode, expected);
    assert.equal(calls.engineInput.plan, expected);
  }
});

test("権利のないdeepとinactive有料はdowngradeせずengine前に拒否する", async () => {
  for (const membership of [{}, { plan: "premium", subscription_status: "inactive", deep_enabled: true }, { plan: "premium", subscription_status: "active", deep_enabled: false }]) {
    const { handler, calls } = setup({ membership });
    const response = await handler(event({ body: JSON.stringify({ name: "架空", birth_date: "1984-12-29", requested_mode: "deep" }) }));
    assert.equal(response.statusCode, 403);
    assert.equal(body(response).error.code, "READING_MODE_NOT_AVAILABLE");
    assert.equal(calls.engine, 0);
  }
});

test("engineは検証済み入力とJST日付で1回だけ実行しfreeはBedrockを呼ばない", async () => {
  const { handler, calls } = setup();
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  assert.equal(calls.engine, 1);
  assert.equal(calls.renderer, 0);
  assert.deepEqual(calls.engineInput, { name: "架空 花子", birthDate: "1984-12-29", today: "2026-07-17", plan: "free" });
});

test("light/deepはrendererを1回呼びrendered結果だけを公開DTOへ変換する", async () => {
  const { handler, calls } = setup({ membership: { plan: "light", subscription_status: "active" } });
  const response = await handler(event()); const value = body(response);
  assert.equal(calls.engine, 1); assert.equal(calls.renderer, 1);
  assert.equal(value.rendering_status, "rendered");
  assert.equal(value.result.sections[0].body, "整形済み本文");
  assert.deepEqual(Object.keys(value.result).sort(), ["avoid_hint", "one_step", "sections", "title"].sort());
  assert.doesNotMatch(response.body, /user_id|knowledge|audio|unknownInternal|model|AWS|fixture-user/i);
});

test("rendererがcanonical fallbackを返す場合も200で安全な結果を返す", async () => {
  const { handler } = setup({ membership: { plan: "light", subscription_status: "active" }, rendererMode: "fallback" });
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).rendering_status, "fallback");
  assert.doesNotMatch(response.body, /provider_error|raw|stack/i);
});

test("completed replayはengine/rendererを呼ばず保存済み結果へ新request_idだけを付ける", async () => {
  const { handler, calls } = setup({ persistenceKind: "replay", membership: { plan: "light", subscription_status: "active" } });
  const response = await handler(event()); const value = body(response);
  assert.equal(response.statusCode, 200); assert.equal(value.history_id, "saved-history"); assert.equal(value.request_id, "gateway-request-001");
  assert.deepEqual([calls.engine, calls.renderer], [0, 0]);
});

test("conflict/in-progressとtransaction失敗は生成・成功応答を安全に止める", async () => {
  for (const persistenceKind of ["conflict", "in_progress"]) {
    const { handler, calls } = setup({ persistenceKind }); const response = await handler(event());
    assert.equal(response.statusCode, 409); assert.equal(calls.engine, 0);
  }
  const failed = setup({ persistenceKind: "complete_error" });
  assert.equal((await failed.handler(event())).statusCode, 503); assert.equal(failed.calls.engine, 1);
});

test("deep永続化経路は追加kill switch未設定相当で拒否する", async () => {
  const { handler, calls } = setup({ deepEnabled: false, membership: { plan: "premium", subscription_status: "active", deep_enabled: true } });
  const response = await handler(event({ body: JSON.stringify({ name: "架空", birth_date: "1984-12-29", requested_mode: "deep" }) }));
  assert.equal(response.statusCode, 403); assert.equal(body(response).error.code, "READING_DEEP_DISABLED"); assert.equal(calls.engine, 0);
});

test("予期しない例外は固定500、request_idはheader/bodyで一致する", async () => {
  const { handler } = setup({ membership: { plan: "light", subscription_status: "active" }, rendererMode: "throw" });
  const response = await handler(event()); const value = body(response);
  assert.equal(response.statusCode, 500);
  assert.equal(value.error.code, "INTERNAL_ERROR");
  assert.equal(value.error.request_id, response.headers["X-Request-Id"]);
  assert.doesNotMatch(response.body, /raw provider secret|stack/i);
});

test("監査logはHMAC user_refを使いtoken・PII・key・本文を含めない", async () => {
  const { handler, audit } = setup({ membership: { plan: "light", subscription_status: "active" } });
  await handler(event({ body: JSON.stringify({ name: "秘密氏名", birth_date: "1984-12-29", question: "秘密相談" }) }));
  assert.ok(audit.length >= 2);
  const joined = audit.join("\n");
  assert.match(joined, /user_ref/);
  assert.doesNotMatch(joined, /秘密氏名|秘密相談|fixture-user|550e8400|Bearer|birth_date|公開本文|整形済み本文/i);
});

test("deep quota監査は固定eventだけを記録し内部予約情報を出さない", async () => {
  const { handler, audit } = setup({ membership: { plan: "premium", subscription_status: "active", deep_enabled: true }, deepReservation: true });
  const response = await handler(event({ body: JSON.stringify({ name: "架空", birth_date: "1984-12-29", requested_mode: "deep" }) }));
  assert.equal(response.statusCode, 200);
  const joined = audit.join("\n");
  assert.match(joined, /deep_quota_reserved/); assert.match(joined, /deep_quota_consumed/);
  assert.doesNotMatch(joined, /fixture-reservation|q{32}|fixture-history|fixture-owner|fixture-user|550e8400/i);
});

test("handler artifactはNode 22 ESMで禁止依存・secret・fixtureを含まない", async () => {
  const artifactPath = "dist/reading-api-handler/index.mjs";
  const artifact = fs.readFileSync(artifactPath, "utf8");
  assert.ok(fs.statSync(artifactPath).size > 0);
  assert.doesNotMatch(artifact, /\b(window|document|localStorage|sessionStorage|XMLHttpRequest|DOMParser)\b|astro\/client|@vite\/client/i);
  assert.doesNotMatch(artifact, /PUBLIC_/);
  assert.doesNotMatch(artifact, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_|fixture-user-001|秘密氏名/);
  assert.ok(Object.keys(handlerBuild.metafile.inputs).some((name) => name.includes("readingApiHandler.ts")));
  assert.ok(Object.keys(foundationBuild.metafile.inputs).some((name) => name.includes("readingApiService.ts")));
  const module = await import(`${new URL(`../${artifactPath}`, import.meta.url).href}?import=${Date.now()}`);
  assert.equal(typeof module.handler, "function");
});
