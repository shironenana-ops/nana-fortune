import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/reading-request-preparation-test/index.mjs";
const buildResult = await build({
  entryPoints: ["src/server/readingServerFoundation.ts"],
  outfile,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  metafile: true,
  logLevel: "silent",
});
const foundation = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);
const KEY = "550e8400-e29b-41d4-a716-446655440000";
const clock = (iso = "2026-07-16T15:00:00.000Z") => ({ now: () => new Date(iso) });

function context(membership = {}) {
  return {
    userId: "fixture-user-001",
    membership,
    entitlements: foundation.getMembershipEntitlements(membership),
  };
}

function prepare({ body = { name: " 白音 七 ", birth_date: "2000-02-29" }, membership = {}, key = KEY, now, lines = [] } = {}) {
  return foundation.prepareReadingRequest({
    rawRequest: body,
    idempotencyKey: key,
    membershipContext: context(membership),
    clock: clock(now),
    requestId: "req-fixture-001",
    audit: { sink: (line) => lines.push(line), auditHashSecret: "fixture-only-audit-secret" },
  });
}

function code(fn) {
  try {
    fn();
    assert.fail("expected a typed error");
  } catch (error) {
    assert.equal(typeof error?.code, "string");
    return error.code;
  }
}

test("requestはunknownからwhitelist済みの新規objectへ変換する", () => {
  const input = { name: " 白音 七 ", birth_date: "2000-02-29", question: " 相談\nです ", requested_mode: "free" };
  const value = foundation.validateReadingRequest(input, "2026-07-17");
  assert.deepEqual(value, { name: "白音 七", birthDate: "2000-02-29", question: "相談\nです", requestedMode: "free" });
  assert.notEqual(value, input);
  for (const invalid of [null, [], "x", 1, true, {}, Object.create({ name: "x", birth_date: "2000-01-01" })]) {
    assert.equal(code(() => foundation.validateReadingRequest(invalid, "2026-07-17")), "READING_REQUEST_INVALID");
  }
});

test("未知field・特権field・camelCase・genderを拒否する", () => {
  for (const field of ["user_id", "userId", "plan", "status", "today", "current_date", "created_at", "gender", "birthDate", "requestedMode", "unknown"]) {
    assert.equal(code(() => foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", [field]: "x" }, "2026-07-17")), "READING_REQUEST_INVALID");
  }
});

test("nameはtrim・Unicode code point上限・制御文字拒否を行う", () => {
  assert.equal(foundation.validateReadingRequest({ name: ` ${"𠮷".repeat(80)} `, birth_date: "2000-01-01" }, "2026-07-17").name.length, 160);
  for (const name of ["", "   ", 12, "a\0b", "a\nb", "a\u007fb"]) {
    assert.equal(code(() => foundation.validateReadingRequest({ name, birth_date: "2000-01-01" }, "2026-07-17")), "READING_REQUEST_INVALID");
  }
  assert.equal(code(() => foundation.validateReadingRequest({ name: "𠮷".repeat(81), birth_date: "2000-01-01" }, "2026-07-17")), "READING_INPUT_TOO_LONG");
});

test("birth_dateは厳密な実在日・1900下限・JST server today上限を使う", () => {
  for (const birth_date of ["2000-1-01", "2000-02-30", "2100-02-29", "1899-12-31", "2026-07-18", 20000101]) {
    assert.equal(code(() => foundation.validateReadingRequest({ name: "白音", birth_date }, "2026-07-17")), "READING_BIRTH_DATE_INVALID");
  }
  assert.equal(foundation.validateReadingRequest({ name: "白音", birth_date: "1900-01-01" }, "2026-07-17").birthDate, "1900-01-01");
  assert.equal(foundation.validateReadingRequest({ name: "白音", birth_date: "2000-02-29" }, "2026-07-17").birthDate, "2000-02-29");
});

test("questionは空をundefinedへ正規化し改行を許可する", () => {
  assert.equal(foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", question: "  " }, "2026-07-17").question, undefined);
  assert.equal(foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", question: "一行\n二行" }, "2026-07-17").question, "一行\n二行");
  assert.equal(code(() => foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", question: "a".repeat(2001) }, "2026-07-17")), "READING_INPUT_TOO_LONG");
  assert.equal(code(() => foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", question: "a\0b" }, "2026-07-17")), "READING_REQUEST_INVALID");
});

test("requested_modeは厳密なlowercase列挙だけを許可する", () => {
  for (const requested_mode of ["premium", "FREE", " light ", "", 1]) {
    assert.equal(code(() => foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", requested_mode }, "2026-07-17")), "READING_MODE_INVALID");
  }
  for (const requested_mode of ["free", "light", "deep"]) {
    assert.equal(foundation.validateReadingRequest({ name: "白音", birth_date: "2000-01-01", requested_mode }, "2026-07-17").requestedMode, requested_mode);
  }
});

test("Idempotency-Keyはtrimしないcanonical lowercase UUID v4だけを許可する", () => {
  assert.equal(foundation.validateIdempotencyKey(KEY), KEY);
  for (const value of [undefined, null, ""]) assert.equal(code(() => foundation.validateIdempotencyKey(value)), "IDEMPOTENCY_KEY_REQUIRED");
  for (const value of [` ${KEY}`, KEY.toUpperCase(), "550e8400-e29b-11d4-a716-446655440000", "550e8400-e29b-41d4-7716-446655440000", [KEY], `${KEY},${KEY}`, `${KEY}\n`, "＊".repeat(36)]) {
    assert.equal(code(() => foundation.validateIdempotencyKey(value)), "IDEMPOTENCY_KEY_INVALID");
  }
});

test("Asia/Tokyo日付はJST境界・月末・年末・うるう日をClockで再現する", () => {
  assert.equal(foundation.getServerReadingDate(clock("2026-07-16T14:59:59.999Z")), "2026-07-16");
  assert.equal(foundation.getServerReadingDate(clock("2026-07-16T15:00:00.000Z")), "2026-07-17");
  assert.equal(foundation.getServerReadingDate(clock("2025-12-31T15:00:00.000Z")), "2026-01-01");
  assert.equal(foundation.getServerReadingDate(clock("2024-02-28T15:00:00.000Z")), "2024-02-29");
  assert.equal(foundation.getServerReadingDate(clock("2026-04-30T15:00:00.000Z")), "2026-05-01");
});

test("会員状態ごとのdefaultと明示modeを既存resolverで解決する", () => {
  assert.equal(prepare().resolvedMode, "free");
  assert.equal(prepare({ membership: { plan: "light", subscription_status: "active" } }).resolvedMode, "light");
  assert.equal(prepare({ membership: { plan: "premium", subscription_status: "active", deep_enabled: true } }).resolvedMode, "light");
  assert.equal(prepare({ body: { name: "白音", birth_date: "2000-01-01", requested_mode: "deep" }, membership: { plan: "premium", subscription_status: "active", deep_enabled: true } }).resolvedMode, "deep");
  for (const membership of [
    {},
    { plan: "light", subscription_status: "active" },
    { plan: "light", subscription_status: "inactive" },
    { plan: "premium", subscription_status: "active", deep_enabled: false },
    { plan: "premium", subscription_status: "inactive", deep_enabled: true },
    { plan: "normal", subscription_status: "active", stripe_customer_email: "ignored@example.invalid" },
  ]) {
    assert.equal(code(() => prepare({ body: { name: "白音", birth_date: "2000-01-01", requested_mode: "deep" }, membership })), "READING_MODE_NOT_AVAILABLE");
  }
});

test("PreparedReadingCommandはtoken由来userId・server date・modeだけを構成しengine/historyを実行しない", () => {
  const command = prepare({ body: { name: " 白音 ", birth_date: "2000-01-01", question: " 相談 ", requested_mode: "free", } });
  assert.deepEqual(command, {
    idempotencyKey: KEY,
    userId: "fixture-user-001",
    requestedMode: "free",
    resolvedMode: "free",
    engineInput: { name: "白音", birthDate: "2000-01-01", question: "相談", today: "2026-07-17", plan: "free" },
  });
  assert.equal("rawRequest" in command, false);
  assert.equal("history" in command, false);
  assert.equal("gender" in command.engineInput, false);
});

test("safe errorと監査logは固定項目のみでPII・key・userIdを含めない", () => {
  const lines = [];
  const errorCode = code(() => prepare({ body: { name: "秘密氏名", birth_date: "2000-01-01", question: "秘密相談", requested_mode: "deep" }, key: KEY, lines }));
  assert.equal(errorCode, "READING_MODE_NOT_AVAILABLE");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.error_code, "READING_MODE_NOT_AVAILABLE");
  assert.equal(record.deep_entitled, false);
  assert.doesNotMatch(lines[0], /秘密氏名|秘密相談|fixture-user|550e8400|birth_date|question|authorization/i);
  const response = foundation.toSafeErrorResponse(new foundation.ServerFoundationError(errorCode, { cause: new Error("internal secret") }), "req-fixture-001");
  assert.equal(response.status, 403);
  assert.deepEqual(Object.keys(response.body.error), ["code", "message", "request_id"]);
  assert.doesNotMatch(JSON.stringify(response), /internal secret|stack/i);
});

test("Node bundleは既存resolver/entitlementsを含み禁止依存やsecretを含まない", () => {
  const inputs = Object.keys(buildResult.metafile.inputs).join("\n");
  assert.match(inputs, /readingModeResolution\.ts/);
  assert.match(inputs, /membershipEntitlements\.ts/);
  const artifact = fs.readFileSync(outfile, "utf8");
  assert.doesNotMatch(artifact, /\b(window|document|localStorage|sessionStorage|fetch|XMLHttpRequest|DOMParser)\b|PUBLIC_|astro\/client|@vite\/client/i);
  assert.doesNotMatch(artifact, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_|fixture-user-001|秘密氏名/);
});
