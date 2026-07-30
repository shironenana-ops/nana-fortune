import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/fincode-webhook-foundation-test/index.mjs";
await build({
  entryPoints: ["src/server/fincode/index.ts"],
  outfile,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const fincode = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);

const SIGNATURE = "fixture-static-shared-value-not-a-real-secret";
const SHOP = "s_abcdefghijk";
const PLAN = "pl_fixture_light";
const CUSTOMER = `stg_${"a".repeat(24)}`;
const SUBSCRIPTION = "su_fixture_subscription";
const PROCESS_DATE = "2026/07/30 09:10:11.123";

function boundary(overrides = {}) {
  return {
    enabled: true,
    environment: "staging",
    customerReferencePrefix: "stg_",
    allowedShopRefs: new Set([SHOP]),
    allowedPlanRefs: new Set([PLAN]),
    productionIdentifiers: new Set(["s_prod0000000", "pl_production"]),
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    shop_id: SHOP,
    subscription_id: SUBSCRIPTION,
    plan_id: PLAN,
    customer_id: CUSTOMER,
    card_id: "ignored-card-reference",
    default_card_flag: "0",
    status: "ACTIVE",
    client_field_1: null,
    client_field_2: "opaque-fixture-note",
    client_field_3: null,
    process_date: PROCESS_DATE,
    start_date: "2026/08/01 00:00:00.000",
    stop_date: null,
    next_charge_date: "2026/09/01 00:00:00.000",
    end_month_flag: "0",
    pay_type: "Card",
    event: "subscription.card.regist",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    contentType: "application/json; charset=utf-8",
    rawBody: JSON.stringify(payload()),
    headers: { "fincode-signature": SIGNATURE },
    expectedSignature: SIGNATURE,
    boundary: boundary(),
    ...overrides,
  };
}

function code(fn, expected) {
  assert.throws(fn, (error) => error?.code === expected && error.message === expected);
}

test("static shared signatureは大文字小文字を問わない単一headerのexact matchだけ受理する", () => {
  assert.doesNotThrow(() => fincode.verifyFincodeWebhookSignature({
    headers: { "FINCODE-SIGNATURE": SIGNATURE },
    expectedSignature: SIGNATURE,
  }));
  code(() => fincode.verifyFincodeWebhookSignature({ headers: {}, expectedSignature: SIGNATURE }), "WEBHOOK_SIGNATURE_MISSING");
  code(() => fincode.verifyFincodeWebhookSignature({ headers: { "fincode-signature": "" }, expectedSignature: SIGNATURE }), "WEBHOOK_SIGNATURE_MISSING");
  code(() => fincode.verifyFincodeWebhookSignature({ headers: { "fincode-signature": "wrong" }, expectedSignature: SIGNATURE }), "WEBHOOK_SIGNATURE_INVALID");
  code(() => fincode.verifyFincodeWebhookSignature({ headers: { "fincode-signature": [SIGNATURE, SIGNATURE] }, expectedSignature: SIGNATURE }), "WEBHOOK_SIGNATURE_AMBIGUOUS");
  code(() => fincode.verifyFincodeWebhookSignature({ headers: { "Fincode-Signature": SIGNATURE, "fincode-signature": SIGNATURE }, expectedSignature: SIGNATURE }), "WEBHOOK_SIGNATURE_AMBIGUOUS");
  code(() => fincode.verifyFincodeWebhookSignature({ headers: { "fincode-signature": SIGNATURE }, expectedSignature: "" }), "WEBHOOK_SIGNATURE_NOT_CONFIGURED");
});

test("署名検証をJSON parseより先に実行し、secretやheader値をerrorへ混入させない", () => {
  code(() => fincode.validateAndNormalizeFincodeWebhook({
    ...request({ rawBody: "{invalid", headers: { "fincode-signature": "sensitive-wrong-value" } }),
  }), "WEBHOOK_SIGNATURE_INVALID");
  try {
    fincode.verifyFincodeWebhookSignature({ headers: { "fincode-signature": "sensitive-header" }, expectedSignature: SIGNATURE });
    assert.fail("expected rejection");
  } catch (error) {
    const serialized = JSON.stringify({ name: error.name, message: error.message, code: error.code });
    assert.doesNotMatch(serialized, /sensitive|fixture-static/);
  }
  const source = fs.readFileSync("src/server/fincode/webhookSignature.ts", "utf8");
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /createHmac/);
});

test("transportはPOSTとapplication/jsonだけを許可しbody上限をfail closedする", () => {
  assert.equal(fincode.validateFincodeWebhookTransport({ method: "POST", contentType: "application/json", rawBody: "{}" }), "{}");
  code(() => fincode.validateFincodeWebhookTransport({ method: "GET", contentType: "application/json", rawBody: "{}" }), "WEBHOOK_METHOD_INVALID");
  code(() => fincode.validateFincodeWebhookTransport({ method: "POST", contentType: "text/plain", rawBody: "{}" }), "WEBHOOK_CONTENT_TYPE_INVALID");
  code(() => fincode.validateFincodeWebhookTransport({ method: "POST", contentType: "application/json", rawBody: "x".repeat(fincode.FINCODE_WEBHOOK_MAX_BODY_BYTES + 1) }), "WEBHOOK_BODY_TOO_LARGE");
});

test("subscription.cardの3eventと公式statusを正規化し、未知の追加fieldは出力しない", () => {
  for (const event of fincode.FINCODE_SUBSCRIPTION_EVENTS) {
    const normalized = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ event })) }));
    assert.equal(normalized.eventType, event);
    assert.equal(normalized.environment, "staging");
    assert.match(normalized.semanticEventKey, /^[0-9a-f]{64}$/);
    assert.match(normalized.payloadFingerprint, /^[0-9a-f]{64}$/);
    assert.equal("card_id" in normalized, false);
    assert.equal("next_charge_date" in normalized, false);
  }
  for (const status of fincode.FINCODE_SUBSCRIPTION_STATUSES) {
    const normalized = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ status })) }));
    assert.equal(normalized.status, status);
  }
});

test("schemaはrequired、nullable、日付、event、status、subscription参照を検証する", () => {
  const nullable = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ start_date: null, stop_date: null, client_field_2: null })) }));
  assert.equal(nullable.startDate, null);
  assert.deepEqual(nullable.clientFields, [null, null, null]);
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: "{" })), "WEBHOOK_JSON_INVALID");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ event: "recurring.card.batch" })) })), "WEBHOOK_EVENT_UNSUPPORTED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ status: "UNKNOWN" })) })), "WEBHOOK_STATUS_UNSUPPORTED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ subscription_id: null })) })), "WEBHOOK_SUBSCRIPTION_REFERENCE_REQUIRED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ process_date: "2026/02/30 00:00:00.000" })) })), "WEBHOOK_SCHEMA_INVALID");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ pay_type: "Directdebit" })) })), "WEBHOOK_SCHEMA_INVALID");
});

test("staging境界はkill switch、shop、plan、customer prefix、production識別子を拒否する", () => {
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ boundary: boundary({ enabled: false }) })), "WEBHOOK_DISABLED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ shop_id: "s_unknown0000" })) })), "WEBHOOK_SHOP_NOT_ALLOWED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ plan_id: "pl_unknown" })) })), "WEBHOOK_PLAN_NOT_ALLOWED");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ customer_id: `prd_${"b".repeat(24)}` })) })), "WEBHOOK_CUSTOMER_REFERENCE_INVALID");
  code(() => fincode.validateAndNormalizeFincodeWebhook(request({
    rawBody: JSON.stringify(payload({ shop_id: "s_prod0000000" })),
    boundary: boundary({ allowedShopRefs: new Set(["s_prod0000000"]) }),
  })), "WEBHOOK_PRODUCTION_IDENTIFIER_REJECTED");
});

test("semantic keyとfingerprintは決定的でevent、処理日、環境、内容差を区別する", () => {
  const first = fincode.validateAndNormalizeFincodeWebhook(request());
  const same = fincode.validateAndNormalizeFincodeWebhook(request());
  assert.equal(first.semanticEventKey, same.semanticEventKey);
  assert.equal(first.payloadFingerprint, same.payloadFingerprint);

  const changedEvent = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ event: "subscription.card.update" })) }));
  const changedDate = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ process_date: "2026/07/30 09:10:12.123" })) }));
  const production = fincode.normalizeFincodeSubscriptionEvent({
    environment: "production",
    payload: fincode.parseFincodeSubscriptionPayload(JSON.stringify(payload()), boundary()),
  });
  assert.notEqual(first.semanticEventKey, changedEvent.semanticEventKey);
  assert.notEqual(first.semanticEventKey, changedDate.semanticEventKey);
  assert.notEqual(first.semanticEventKey, production.semanticEventKey);
});

test("同一key＋同一fingerprintはduplicate、内容差はconflictでraw payloadをledgerへ残さない", () => {
  const incoming = fincode.validateAndNormalizeFincodeWebhook(request());
  const ledger = {
    semanticEventKey: incoming.semanticEventKey,
    payloadFingerprint: incoming.payloadFingerprint,
    environment: incoming.environment,
    eventType: incoming.eventType,
    status: incoming.status,
    decision: "ACTIVATE_SUBSCRIPTION",
  };
  assert.equal(fincode.classifyFincodeWebhookReplay({ incoming, existing: null }), "new");
  assert.equal(fincode.classifyFincodeWebhookReplay({ incoming, existing: ledger }), "duplicate");
  assert.equal(fincode.classifyFincodeWebhookReplay({ incoming, existing: { ...ledger, payloadFingerprint: "f".repeat(64) } }), "conflict");
  const serialized = JSON.stringify(ledger);
  for (const raw of [SHOP, PLAN, CUSTOMER, SUBSCRIPTION, SIGNATURE]) assert.doesNotMatch(serialized, new RegExp(raw));
});

test("transitionは純粋decisionだけを返しwriter mutationを許可しない", () => {
  const cases = [
    ["ACTIVE", "subscription.card.regist", "ACTIVATE_SUBSCRIPTION"],
    ["ACTIVE", "subscription.card.update", "UPDATE_SUBSCRIPTION"],
    ["RUNNING", "subscription.card.update", "UPDATE_SUBSCRIPTION"],
    ["CANCELED", "subscription.card.delete", "CANCEL_SUBSCRIPTION"],
    ["INCOMPLETE", "subscription.card.regist", "RECORD_INCOMPLETE"],
  ];
  for (const [status, event, expected] of cases) {
    const normalized = fincode.validateAndNormalizeFincodeWebhook(request({ rawBody: JSON.stringify(payload({ status, event })) }));
    const result = fincode.decideFincodeSubscriptionTransition(normalized);
    assert.equal(result.decision, expected);
    assert.equal(result.mutationAllowed, false);
  }
  const source = fs.readFileSync("src/server/fincode/webhookTransition.ts", "utf8");
  assert.doesNotMatch(source, /Dynamo|UpdateItem|PutItem|fetch\s*\(/);
});

test("Webhook監査logはdigest参照と固定結果だけを記録し秘密・生ID・payloadを含めない", () => {
  const incoming = fincode.validateAndNormalizeFincodeWebhook(request());
  const lines = [];
  const record = fincode.writeFincodeWebhookAuditLog({
    correlationId: "fixture-correlation",
    eventReference: incoming.semanticEventKey,
    eventType: incoming.eventType,
    environment: incoming.environment,
    verificationOutcome: "accepted",
    replayOutcome: "new",
    transitionDecision: "ACTIVATE_SUBSCRIPTION",
    durationMs: 12,
    resultCode: "WEBHOOK_ACCEPTED",
  }, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.equal(record.event_ref, incoming.semanticEventKey);
  const serialized = JSON.stringify({ record, lines });
  for (const raw of [SIGNATURE, SHOP, PLAN, CUSTOMER, SUBSCRIPTION, JSON.stringify(payload()), "raw provider exception"]) {
    assert.doesNotMatch(serialized, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const guarded = fincode.createFincodeWebhookAuditRecord({
    correlationId: "email-like@example.invalid",
    eventReference: incoming.semanticEventKey,
    environment: "staging",
    verificationOutcome: "error",
    resultCode: "raw provider exception",
  });
  assert.equal(guarded.correlation_id, "invalid");
  assert.equal(guarded.result_code, "WEBHOOK_INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(guarded), /example\.invalid|raw provider exception/);
});
