import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const output = "dist/fincode-provisional-test-adapters/index.mjs";
await build({ entryPoints: ["src/server/fincode/index.ts"], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", target: "node22", logLevel: "silent" });
const api = await import(`${new URL(`../${output}`, import.meta.url).href}?v=${Date.now()}`);

const provider = { apiOrigin: "https://api.test.fincode.jp", secretKey: "m_test_FAKE_ONLY", shopId: "s_fixture00000" };
const periodInput = {
  environment: "staging", subscriptionReference: "su_fixture", subscriptionDigest: "a".repeat(64),
  customerReference: "stg_customer_fixture_000000000000", customerDigest: "b".repeat(64),
  planReference: "pl_fixture", plan: "light", eventType: "subscription.card.regist", processDate: "2099/01/01 00:00:00.000",
};

test("provisional period source interprets only provider start/end as Asia/Tokyo", async () => {
  const source = new api.ProvisionalFincodeTestAsiaTokyoPeriodSource(provider, async () => new Response(JSON.stringify({
    id: "su_fixture", customer_id: periodInput.customerReference, plan_id: "pl_fixture", pay_type: "Card", status: "ACTIVE",
    start_date: "2026/08/01 00:00:00.000", next_charge_date: "2026/09/01 00:00:00.000",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const result = await source.resolve(periodInput);
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.periodStart, "2026-07-31T15:00:00.000Z");
  assert.equal(result.periodEnd, "2026-08-31T15:00:00.000Z");
  assert.equal(result.source, "PROVISIONAL_FINCODE_TEST_ASIA_TOKYO");
  assert.notEqual(result.periodStart, periodInput.processDate);
});

test("provisional period source is staging-only and fails closed on mismatch/missing dates", async () => {
  let calls = 0;
  const source = new api.ProvisionalFincodeTestAsiaTokyoPeriodSource(provider, async () => { calls++; return new Response("{}", { status: 200 }); });
  assert.deepEqual(await source.resolve({ ...periodInput, environment: "production" }), { status: "UNAVAILABLE" });
  assert.equal(calls, 0);
  const mismatch = new api.ProvisionalFincodeTestAsiaTokyoPeriodSource(provider, async () => new Response(JSON.stringify({
    id: "su_fixture", customer_id: "different", plan_id: "pl_fixture", pay_type: "Card", status: "ACTIVE",
    start_date: "2026/08/01 00:00:00.000", next_charge_date: null,
  }), { status: 200 }));
  assert.deepEqual(await mismatch.resolve(periodInput), { status: "CONFLICT" });
});

test("provisional period source keeps an unstarted equal-date period retryable", async () => {
  const source = new api.ProvisionalFincodeTestAsiaTokyoPeriodSource(provider, async () => new Response(JSON.stringify({
    id: "su_fixture", customer_id: periodInput.customerReference, plan_id: "pl_fixture", pay_type: "Card", status: "ACTIVE",
    start_date: "2026/08/04 00:00:00.000", next_charge_date: "2026/08/04 00:00:00.000",
  }), { status: 200 }));
  assert.deepEqual(await source.resolve(periodInput), { status: "NOT_AVAILABLE" });
});

function webhook(body, signature = "fixture-signature") {
  return { version: "2.0", routeKey: "POST /webhooks/fincode", headers: { "content-type": "application/json", "fincode-signature": signature }, body: JSON.stringify(body), isBase64Encoded: false, requestContext: { requestId: "fixture-request", http: { method: "POST" } } };
}

test("signed payment trigger re-queries provider and grants captured 300 yen exactly once", async () => {
  let grants = 0;
  const audit = [];
  const intent = api.createFincodeOneTimeVoicePurchaseIntent({ environment: "staging", shopReference: provider.shopId, paymentReference: "o_fixture", userReference: "fixture_user" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "o_fixture", shop_id: provider.shopId, amount: 300, tax: 0, pay_type: "Card", job_code: "CAPTURE", status: "CAPTURED" }), { status: 200 });
  try {
    const response = await api.orchestrateFincodeOneTimeVoiceWebhook({
      event: webhook({ event: "payments.card.exec", pay_type: "Card", order_id: "o_fixture" }), expectedSignature: "fixture-signature", provider,
      intents: { async findByPaymentDigest() { return grants ? { ...intent, state: "COMPLETED" } : intent; } },
      grants: { async grant() { grants++; return "COMPLETED"; } }, auditSink: (line) => audit.push(JSON.parse(line)), now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(grants, 1);
    assert.deepEqual(audit, [{ event: "fincode_voice_single", result_code: "VOICE_COMPLETED" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("payment webhook rejects bad signature and mismatched verified amount without grant", async () => {
  let grants = 0;
  const audit = [];
  const originalFetch = globalThis.fetch;
  let providerBody = { id: "o_fixture", shop_id: provider.shopId, amount: 301, tax: 0, pay_type: "Card", job_code: "CAPTURE", status: "CAPTURED" };
  globalThis.fetch = async () => new Response(JSON.stringify(providerBody), { status: 200 });
  try {
    const dependencies = { expectedSignature: "fixture-signature", provider, intents: { async findByPaymentDigest() { throw new Error("must not reach"); } }, grants: { async grant() { grants++; return "COMPLETED"; } }, auditSink: (line) => audit.push(JSON.parse(line)) };
    assert.equal((await api.orchestrateFincodeOneTimeVoiceWebhook({ ...dependencies, event: webhook({ event: "payments.card.exec", pay_type: "Card", order_id: "o_fixture" }, "wrong") })).statusCode, 401);
    assert.equal((await api.orchestrateFincodeOneTimeVoiceWebhook({ ...dependencies, event: webhook({ event: "payments.card.exec", pay_type: "Card", order_id: "o_fixture" }) })).statusCode, 503);
    providerBody = { ...providerBody, amount: "300", tax: "0" };
    assert.equal((await api.orchestrateFincodeOneTimeVoiceWebhook({ ...dependencies, event: webhook({ event: "payments.card.exec", pay_type: "Card", order_id: "o_fixture" }) })).statusCode, 503);
    assert.equal(grants, 0);
    assert.deepEqual(audit.map((entry) => entry.result_code), ["VOICE_SIGNATURE_DENIED", "VOICE_PROVIDER_UNAVAILABLE", "VOICE_PROVIDER_UNAVAILABLE"]);
    assert.doesNotMatch(JSON.stringify(audit), /fixture-signature|o_fixture|raw-secret/u);
  } finally { globalThis.fetch = originalFetch; }
});
