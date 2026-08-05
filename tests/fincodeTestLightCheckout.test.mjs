import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "dist/fincode-test-light-checkout-test/index.mjs";
await build({
  entryPoints: ["src/server/fincode/test/index.ts"], outfile, bundle: true,
  packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent",
});
const light = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);

const USER_ID = "browser-fixture@staging.invalid";
const IDEMPOTENCY_KEY = "1003d6af-9e68-4f4e-a916-663e29db5377";
const SUBSCRIPTION_KEY = "a103d6af-9e68-4f4e-a916-663e29db5377";
const PLAN_ID = "pl_FAKE_LIGHT_TEST";
const CARD_ID = "c_FAKE_TEST_CARD";
const BASE_ENV = Object.freeze({
  FINCODE_TEST_PAYMENT_ENABLED: "true",
  FINCODE_TEST_API_BASE: light.FINCODE_TEST_API_ORIGIN,
  FINCODE_TEST_SECRET_KEY: "m_test_FAKE_FOR_UNIT_TEST_ONLY",
  FINCODE_TEST_SHOP_ID: "s_FAKE_TEST_SHOP",
  FINCODE_TEST_BROWSER_E2E_PROFILE: "light-browser-e2e",
  FINCODE_TEST_LIGHT_START_DATE: "2026/08/04",
  PUBLIC_RUNTIME_ENV: "local-staging",
  PUBLIC_STAGING_AUTH_ENABLED: "true",
  PUBLIC_STAGING_API_BASE_URL: "https://example.execute-api.ap-northeast-1.amazonaws.com/staging",
  PUBLIC_FINCODE_TEST_BROWSER_E2E_PROFILE: "light-browser-e2e",
});
const CONFIG = light.loadFincodeTestLightCheckoutConfig(BASE_ENV);

function token(userId = USER_ID) {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1, exp: 4_102_444_800 })).toString("base64url");
  return `${payload}.unit-test-signature`;
}
function plan(overrides = {}) {
  return { id: PLAN_ID, amount: "980", tax: "0", total_amount: "980", interval_pattern: "month", interval_count: 1, delete_flag: "0", ...overrides };
}
class IntentStore {
  value = null;
  subscriptionId = null;
  async prepare(value) { this.value = structuredClone(value); return "READY"; }
  async find(customerId) { return this.value?.customerId === customerId ? structuredClone(this.value) : null; }
  async markSubmitted(value, subscriptionId) {
    if (!this.value || value.id !== this.value.id) return "CONFLICT";
    this.subscriptionId = subscriptionId; return "SUBMITTED";
  }
}
function providerFetch(observed = [], getIntent = () => null) {
  return async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    observed.push({ href, init, body });
    if (href === CONFIG.membershipStatusUrl) return new Response(JSON.stringify({ plan: "free", subscription_status: "inactive" }));
    if (href.endsWith("/v1/plans")) return new Response(JSON.stringify({ list: [plan()] }));
    if (href.includes("/v1/customers/") && init.method === "GET") return new Response("{}", { status: 404 });
    if (href.endsWith("/v1/customers") && init.method === "POST") return new Response(JSON.stringify({ id: body.id }));
    if (href.endsWith("/v1/subscriptions") && init.method === "POST") return new Response(JSON.stringify({ ...body, shop_id: BASE_ENV.FINCODE_TEST_SHOP_ID, status: "ACTIVE" }));
    if (href.includes("/v1/subscriptions/") && init.method === "GET") {
      const intent = getIntent();
      const id = decodeURIComponent(href.split("/v1/subscriptions/")[1].split("?")[0]);
      return new Response(JSON.stringify({
        id, shop_id: BASE_ENV.FINCODE_TEST_SHOP_ID, pay_type: "Card", plan_id: intent.planReference,
        customer_id: intent.customerId, client_field_1: "light", client_field_2: intent.id,
        client_field_3: "light-browser-e2e", status: "ACTIVE",
      }));
    }
    throw new Error(`unexpected fake URL: ${href}`);
  };
}

test("Light Browser E2E is local-staging only and production stays fail closed", () => {
  assert.equal(CONFIG.runtimeEnvironment, "local-staging");
  for (const override of [
    { PUBLIC_RUNTIME_ENV: "production" }, { PUBLIC_STAGING_AUTH_ENABLED: "false" },
    { PUBLIC_FINCODE_TEST_BROWSER_E2E_PROFILE: "" }, { FINCODE_TEST_BROWSER_E2E_PROFILE: "" },
    { FINCODE_TEST_LIGHT_START_DATE: "" }, { FINCODE_TEST_LIGHT_START_DATE: "2026/02/30" },
    { PUBLIC_STAGING_API_BASE_URL: "https://api.example.com/prod" }, { FINCODE_TEST_API_BASE: "https://api.fincode.jp" },
  ]) assert.throws(() => light.loadFincodeTestLightCheckoutConfig({ ...BASE_ENV, ...override }));
});

test("Light requests are exact and never fall back to voice_single", () => {
  assert.deepEqual(light.validateFincodeTestLightRequest({ action: "prepare", plan: "light" }), { action: "prepare", plan: "light" });
  assert.deepEqual(light.validateFincodeTestLightRequest({ action: "subscribe", plan: "light", customerId: "stg_customer_1", purchaseIntentId: "pi_1", cardId: CARD_ID }).action, "subscribe");
  for (const value of [
    { action: "prepare", plan: "voice_single" }, { action: "prepare", plan: "light", amount: 300 },
    { action: "subscribe", plan: "light", customerId: "../escape", purchaseIntentId: "pi_1", cardId: CARD_ID },
  ]) assert.throws(() => light.validateFincodeTestLightRequest(value), /FINCODE_TEST_REQUEST_INVALID/u);
});

test("plan allow-list is exactly one monthly 980-yen TEST plan", async () => {
  assert.equal(await light.resolveFincodeTestLightPlanReference({ config: CONFIG, fetchImpl: providerFetch() }), PLAN_ID);
  for (const bad of [plan({ amount: "300" }), plan({ interval_pattern: "year" }), plan({ interval_count: 2 }), plan({ delete_flag: "1" })]) {
    await assert.rejects(light.resolveFincodeTestLightPlanReference({ config: CONFIG, fetchImpl: async () => new Response(JSON.stringify({ list: [bad] })) }));
  }
});

test("validated auth, Purchase Intent, card and subscription remain Light-aligned", async () => {
  const store = new IntentStore();
  const observed = [];
  const fetchImpl = providerFetch(observed, () => store.value);
  assert.equal(await light.verifyFincodeTestLightBrowserSession({ config: CONFIG, authorization: `Bearer ${token()}`, fetchImpl }), USER_ID);
  const prepared = await light.prepareFincodeTestLightCheckout({ config: CONFIG, userId: USER_ID, intents: store, fetchImpl });
  assert.deepEqual({ action: prepared.action, product: prepared.product, amount: prepared.amount, billingType: prepared.billingType }, { action: "prepare", product: "light", amount: 980, billingType: "subscription" });
  assert.equal(prepared.customerId.includes("@"), false);

  const request = { action: "subscribe", plan: "light", customerId: prepared.customerId, purchaseIntentId: prepared.purchaseIntentId, cardId: CARD_ID };
  const subscribed = await light.subscribeFincodeTestLightCheckout({ config: CONFIG, userId: USER_ID, request, idempotencyKey: SUBSCRIPTION_KEY, intents: store, fetchImpl });
  assert.deepEqual({ action: subscribed.action, product: subscribed.product, amount: subscribed.amount, billingType: subscribed.billingType, status: subscribed.status }, { action: "subscribe", product: "light", amount: 980, billingType: "subscription", status: "ACTIVE" });
  const post = observed.find((entry) => entry.href.endsWith("/v1/subscriptions"));
  assert.equal(post.body.plan_id, PLAN_ID);
  assert.equal(post.body.customer_id, prepared.customerId);
  assert.equal(post.body.card_id, CARD_ID);
  assert.equal(post.body.start_date, "2026/08/04");
  assert.equal(post.body.client_field_1, "light");
  assert.equal("amount" in post.body, false);
  assert.equal(JSON.stringify(post.body).includes("voice_single"), false);
});

test("membership must be free/inactive and user_id must be staging-only", async () => {
  await assert.rejects(light.verifyFincodeTestLightBrowserSession({ config: CONFIG, authorization: `Bearer ${token("person@example.com")}`, fetchImpl: providerFetch() }), /FINCODE_TEST_AUTH_REJECTED/u);
  await assert.rejects(light.verifyFincodeTestLightBrowserSession({
    config: CONFIG, authorization: `Bearer ${token()}`,
    fetchImpl: async () => new Response(JSON.stringify({ plan: "light", subscription_status: "active" })),
  }), /FINCODE_TEST_AUTH_REJECTED/u);
});

test("existing registration endpoint dispatches Light without a new API route", async () => {
  const store = new IntentStore();
  const fetchImpl = providerFetch([], () => store.value);
  const request = new Request("http://localhost:4321/api/billing/fincode/test/register", {
    method: "POST",
    headers: { origin: "http://localhost:4321", authorization: `Bearer ${token()}`, "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
    body: JSON.stringify({ action: "prepare", plan: "light" }),
  });
  const response = await light.handleFincodeTestRegistration(request, BASE_ENV, fetchImpl, store);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual({ product: body.product, amount: body.amount, billingType: body.billingType }, { product: "light", amount: 980, billingType: "subscription" });
  assert.equal(JSON.stringify(body).includes("voice_single"), false);

  let providerCalls = 0;
  const voice = await light.handleFincodeTestRegistration(new Request(request.url, {
    method: "POST",
    headers: { origin: "http://localhost:4321", "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
    body: JSON.stringify({ plan: "voice_single" }),
  }), BASE_ENV, async () => { providerCalls += 1; return new Response("{}"); }, store);
  assert.equal(voice.status, 403);
  assert.equal(providerCalls, 0);
});

test("Light completion verifies provider and stored intent, then removes identifiers", async () => {
  const store = new IntentStore();
  const fetchImpl = providerFetch([], () => store.value);
  const prepared = await light.prepareFincodeTestLightCheckout({ config: CONFIG, userId: USER_ID, intents: store, fetchImpl });
  const url = new URL("http://localhost:4321/fincode/test/result");
  url.searchParams.set("plan", "light"); url.searchParams.set("customer_id", prepared.customerId);
  url.searchParams.set("subscription_id", "su_FAKE_LIGHT"); url.searchParams.set("purchase_intent_id", prepared.purchaseIntentId);
  const response = await light.handleFincodeTestResult(new Request(url), BASE_ENV, fetchImpl, store);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/fincode/test/complete#light");
  assert.equal(response.headers.get("location").includes("subscription"), false);
});

test("checkout uses the official card UI and has no Light voice fallback", async () => {
  const source = await readFile(new URL("../src/pages/checkout.astro", import.meta.url), "utf8");
  assert.match(source, /ライト会員 月額980円のTEST申込/u);
  assert.match(source, /cardInputUi\.create\("payment"/u);
  assert.match(source, /<form id="fincode-test-light-card-ui-form"/u);
  assert.match(source, /registerCard\(\{ fincode, ui, customerId: prepared\.customerId/u);
  assert.match(source, /body: JSON\.stringify\(\{ action: "prepare", plan: "light" \}\)/u);
  assert.equal(source.indexOf('body: JSON.stringify({ action: "prepare", plan: "light" })') < source.indexOf('cardInputUi.create("payment"'), true);
  assert.match(source, /action: "subscribe"/u);
  assert.doesNotMatch(source, /\/api\/billing\/fincode\/test\/light\//u);
  const lightBlock = source.slice(source.indexOf("const lightRoot"), source.indexOf("const root ="));
  assert.doesNotMatch(lightBlock, /payments\(|plan: "voice_single"|amount: 300/u);
});
