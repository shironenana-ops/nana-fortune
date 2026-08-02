import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { allowFincodeTestRedirectUrl } from "../src/lib/fincodeTestBrowser.ts";

const outfile = "dist/fincode-test-payment-test/index.mjs";
await build({
  entryPoints: ["src/server/fincode/test/index.ts"],
  outfile,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const {
  FINCODE_TEST_AMOUNT,
  FINCODE_TEST_API_ORIGIN,
  assertFincodeTestOnly,
  handleFincodeTestRegistration,
  handleFincodeTestResult,
  isFincodeTestPublicKey,
  loadFincodeTestPaymentConfig,
  registerFincodeTestPayment,
  requestFincodeTestJson,
  validateFincodeTestIdempotencyKey,
  validateFincodeTestPaymentId,
  validateFincodeTestRegistrationPayload,
  verifyFincodeTestPayment,
} = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);

const TEST_ENV = Object.freeze({
  FINCODE_TEST_PAYMENT_ENABLED: "true",
  FINCODE_TEST_API_BASE: FINCODE_TEST_API_ORIGIN,
  FINCODE_TEST_SECRET_KEY: "m_test_FAKE_FOR_UNIT_TEST_ONLY",
  FINCODE_TEST_SHOP_ID: "s_FAKE_TEST_SHOP",
});
const CONFIG = loadFincodeTestPaymentConfig(TEST_ENV);
const IDEMPOTENCY_KEY = "1003d6af-9e68-4f4e-a916-663e29db5377";
const PAYMENT_ID = "o_FAKE_TEST_PAYMENT";
const ACCESS_ID = "a_FAKE_TEST_ACCESS";

function providerPayment(overrides = {}) {
  return {
    shop_id: TEST_ENV.FINCODE_TEST_SHOP_ID,
    id: PAYMENT_ID,
    access_id: ACCESS_ID,
    pay_type: "Card",
    job_code: "CAPTURE",
    amount: "300",
    tax: "0",
    status: "UNPROCESSED",
    ...overrides,
  };
}

function jsonFetch(body, status = 200, extraHeaders = {}) {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

test("TEST payment config is disabled by default and only exact true enables it", () => {
  assert.throws(() => loadFincodeTestPaymentConfig({}), /FINCODE_TEST_DISABLED/u);
  assert.throws(() => loadFincodeTestPaymentConfig({ ...TEST_ENV, FINCODE_TEST_PAYMENT_ENABLED: "TRUE" }), /FINCODE_TEST_DISABLED/u);
  assert.equal(loadFincodeTestPaymentConfig(TEST_ENV).enabled, true);
});

test("TEST payment config fails closed on missing key or shop", () => {
  assert.throws(() => loadFincodeTestPaymentConfig({ ...TEST_ENV, FINCODE_TEST_SECRET_KEY: "" }), /FINCODE_TEST_CONFIGURATION_INVALID/u);
  assert.throws(() => loadFincodeTestPaymentConfig({ ...TEST_ENV, FINCODE_TEST_SHOP_ID: "" }), /FINCODE_TEST_CONFIGURATION_INVALID/u);
  assert.throws(() => loadFincodeTestPaymentConfig({ ...TEST_ENV, FINCODE_TEST_SECRET_KEY: "m_live_FORBIDDEN" }), /FINCODE_TEST_CONFIGURATION_INVALID/u);
});

test("TEST payment config rejects production and arbitrary origins", () => {
  assert.throws(() => assertFincodeTestOnly("https://api.fincode.jp"), /FINCODE_TEST_ENVIRONMENT_REJECTED/u);
  assert.throws(() => assertFincodeTestOnly("https://example.test"), /FINCODE_TEST_ENVIRONMENT_REJECTED/u);
  assert.throws(() => assertFincodeTestOnly("http://api.test.fincode.jp"), /FINCODE_TEST_ENVIRONMENT_REJECTED/u);
  assert.equal(assertFincodeTestOnly(undefined), FINCODE_TEST_API_ORIGIN);
});

test("server config exposes no PUBLIC secret field", () => {
  assert.deepEqual(Object.keys(CONFIG).sort(), ["apiOrigin", "enabled", "secretKey", "shopId"]);
  assert.equal(Object.keys(CONFIG).some((key) => key.startsWith("PUBLIC_")), false);
  assert.equal(isFincodeTestPublicKey("p_test_FAKE"), true);
  assert.equal(isFincodeTestPublicKey("p_live_FORBIDDEN"), false);
});

test("registration accepts only the exact voice_single payload", () => {
  assert.equal(validateFincodeTestRegistrationPayload({ plan: "voice_single" }), "voice_single");
  for (const payload of [
    null,
    {},
    { plan: "light" },
    { plan: "premium" },
    { plan: "unknown" },
    { plan: "voice_single", amount: 1 },
    { plan: "voice_single", price: 300 },
  ]) {
    assert.throws(() => validateFincodeTestRegistrationPayload(payload), /FINCODE_TEST_REQUEST_INVALID/u);
  }
});

test("identifiers require UUIDv4 idempotency and bounded opaque payment IDs", () => {
  assert.equal(validateFincodeTestIdempotencyKey(IDEMPOTENCY_KEY), IDEMPOTENCY_KEY);
  assert.throws(() => validateFincodeTestIdempotencyKey("not-a-uuid"), /FINCODE_TEST_REQUEST_INVALID/u);
  assert.equal(validateFincodeTestPaymentId(PAYMENT_ID), PAYMENT_ID);
  assert.throws(() => validateFincodeTestPaymentId("../escape"), /FINCODE_TEST_REQUEST_INVALID/u);
  assert.throws(() => validateFincodeTestPaymentId("x".repeat(31)), /FINCODE_TEST_REQUEST_INVALID/u);
});

test("3DS redirect permits only the fixed fincode TEST hosts", () => {
  assert.equal(allowFincodeTestRedirectUrl("https://api.test.fincode.jp/v1/secure2/example"), "https://api.test.fincode.jp/v1/secure2/example");
  assert.equal(allowFincodeTestRedirectUrl("https://simulator.test.fincode.jp/v1/secure2/example"), "https://simulator.test.fincode.jp/v1/secure2/example");
  for (const value of [
    "http://api.test.fincode.jp/v1/secure2/example",
    "https://api.fincode.jp/v1/secure2/example",
    "https://api.test.fincode.jp.evil.example/path",
    "https://evil.fincode.jp/path",
    "javascript:alert(1)",
    null,
  ]) {
    assert.equal(allowFincodeTestRedirectUrl(value), null);
  }
});

test("registration fixes amount, Card, CAPTURE and mandatory 3DS on the server", async () => {
  let observed;
  const registered = await registerFincodeTestPayment({
    config: CONFIG,
    idempotencyKey: IDEMPOTENCY_KEY,
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify(providerPayment()), { status: 200 });
    },
  });
  assert.deepEqual(registered, { paymentId: PAYMENT_ID, accessId: ACCESS_ID, payType: "Card" });
  assert.equal(FINCODE_TEST_AMOUNT, 300);
  assert.equal(observed.url, "https://api.test.fincode.jp/v1/payments");
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(observed.init.headers.idempotent_key, IDEMPOTENCY_KEY);
  assert.deepEqual(observed.body, {
    pay_type: "Card",
    job_code: "CAPTURE",
    amount: "300",
    tax: "0",
    tds_type: "2",
    tds2_type: "2",
  });
});

test("registration performs no automatic POST retry", async () => {
  let calls = 0;
  await assert.rejects(
    registerFincodeTestPayment({
      config: CONFIG,
      idempotencyKey: IDEMPOTENCY_KEY,
      fetchImpl: async () => {
        calls += 1;
        return new Response("provider detail must not escape", { status: 503 });
      },
    }),
    /FINCODE_TEST_PROVIDER_UNAVAILABLE/u,
  );
  assert.equal(calls, 1);
});

test("HTTP client timeout is mapped to a fixed safe error", async () => {
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("secret provider detail", "AbortError")));
  });
  await assert.rejects(
    requestFincodeTestJson(CONFIG, { method: "GET", path: "/v1/payments/x?pay_type=Card" }, hangingFetch, 5),
    (error) => error.code === "FINCODE_TEST_PROVIDER_UNAVAILABLE" && !error.message.includes("secret provider detail"),
  );
});

test("HTTP client rejects invalid, non-object and oversized provider responses", async () => {
  await assert.rejects(requestFincodeTestJson(CONFIG, { method: "GET", path: "/v1/payments/x" }, async () => new Response("not-json")), /FINCODE_TEST_RESPONSE_INVALID/u);
  await assert.rejects(requestFincodeTestJson(CONFIG, { method: "GET", path: "/v1/payments/x" }, jsonFetch([])), /FINCODE_TEST_RESPONSE_INVALID/u);
  await assert.rejects(requestFincodeTestJson(CONFIG, { method: "GET", path: "/v1/payments/x" }, jsonFetch({}, 200, { "content-length": "999999" })), /FINCODE_TEST_RESPONSE_INVALID/u);
});

test("provider response boundary rejects shop, amount, method, job and initial status mismatches", async () => {
  for (const override of [
    { shop_id: "s_OTHER" },
    { amount: "301" },
    { tax: "1" },
    { total_amount: "301" },
    { pay_type: "Paypay" },
    { job_code: "AUTH" },
    { status: "CAPTURED" },
    { access_id: "bad access id" },
  ]) {
    await assert.rejects(registerFincodeTestPayment({
      config: CONFIG,
      idempotencyKey: IDEMPOTENCY_KEY,
      fetchImpl: jsonFetch(providerPayment(override)),
    }));
  }
});

test("result verification accepts only the exact captured TEST payment", async () => {
  let observed;
  const verified = await verifyFincodeTestPayment({
    config: CONFIG,
    paymentId: PAYMENT_ID,
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify(providerPayment({ status: "CAPTURED" })));
    },
  });
  assert.deepEqual(verified, { paymentId: PAYMENT_ID, status: "CAPTURED" });
  assert.equal(observed.url, `https://api.test.fincode.jp/v1/payments/${PAYMENT_ID}?pay_type=Card`);
  assert.equal(observed.init.method, "GET");
});

test("result verification fails closed for forged success and boundary mismatches", async () => {
  for (const override of [
    { status: "UNPROCESSED" },
    { status: "AUTHORIZED" },
    { status: "UNKNOWN" },
    { amount: 299 },
    { shop_id: "s_OTHER" },
    { id: "o_OTHER" },
  ]) {
    await assert.rejects(verifyFincodeTestPayment({
      config: CONFIG,
      paymentId: PAYMENT_ID,
      fetchImpl: jsonFetch(providerPayment(override)),
    }));
  }
});

test("registration endpoint requires local same-origin POST JSON", async () => {
  const goodRequest = new Request("http://127.0.0.1:4321/api/billing/fincode/test/register", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4321", "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
    body: JSON.stringify({ plan: "voice_single" }),
  });
  const good = await handleFincodeTestRegistration(goodRequest, TEST_ENV, jsonFetch(providerPayment()));
  assert.equal(good.status, 200);
  assert.deepEqual(await responseJson(good), { ok: true, paymentId: PAYMENT_ID, accessId: ACCESS_ID, payType: "Card" });

  const remote = await handleFincodeTestRegistration(new Request("https://www.nana-fortune.com/api/billing/fincode/test/register", { method: "POST" }), TEST_ENV, jsonFetch(providerPayment()));
  assert.equal(remote.status, 403);
  const crossOrigin = await handleFincodeTestRegistration(new Request(goodRequest.url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), TEST_ENV, jsonFetch(providerPayment()));
  assert.equal(crossOrigin.status, 400);
  const method = await handleFincodeTestRegistration(new Request(goodRequest.url), TEST_ENV, jsonFetch(providerPayment()));
  assert.equal(method.status, 405);
});

test("registration endpoint does not expose raw provider messages", async () => {
  const request = new Request("http://localhost:4321/api/billing/fincode/test/register", {
    method: "POST",
    headers: { origin: "http://localhost:4321", "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
    body: JSON.stringify({ plan: "voice_single" }),
  });
  const response = await handleFincodeTestRegistration(request, TEST_ENV, async () => new Response("raw AWS-like request id and provider error", { status: 500 }));
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(text.includes("raw AWS-like"), false);
  assert.equal(text.includes(TEST_ENV.FINCODE_TEST_SECRET_KEY), false);
});

test("result endpoint verifies on GET and POST and never trusts outcome query", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify(providerPayment({ status: "CAPTURED" })));
  };
  for (const method of ["GET", "POST"]) {
    const response = await handleFincodeTestResult(new Request(`http://localhost:4321/fincode/test/result?payment_id=${PAYMENT_ID}&outcome=failure&success=true`, { method }), TEST_ENV, fetchImpl);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /TEST決済成功/u);
    assert.match(html, /権利付与は行いません/u);
  }
  assert.equal(calls, 2);
});

test("result endpoint presents retryable safe UI on provider outage", async () => {
  const response = await handleFincodeTestResult(
    new Request(`http://localhost:4321/fincode/test/result?payment_id=${PAYMENT_ID}`),
    TEST_ENV,
    async () => { throw new Error("raw internal stack and secret"); },
  );
  const html = await response.text();
  assert.equal(response.status, 503);
  assert.match(html, /再読み込み/u);
  assert.equal(html.includes("raw internal"), false);
});

test("checkout source keeps card data on official JS path and adds no persistence or analytics", async () => {
  const source = await readFile(new URL("../src/pages/checkout.astro", import.meta.url), "utf8");
  assert.match(source, /initFincode/u);
  assert.match(source, /isLiveMode: false/u);
  assert.match(source, /paymentUi\.create\("payment"/u);
  assert.match(source, /paymentUi\.mount\("fincode-test-card-ui", "400"\)/u);
  assert.match(source, /id="fincode-test-card-ui-form"/u);
  assert.match(source, /PUBLIC_FINCODE_TEST_PAYMENT_ENABLED/u);
  assert.match(source, /isFincodeTestCheckoutEnabled/u);
  assert.match(source, /body: JSON\.stringify\(\{ plan: "voice_single" \}\)/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage|analytics|dataLayer|gtag\(/u);
  assert.doesNotMatch(source, /JSON\.stringify\([^\n]*(cardNo|CVC|expire|holderName)/u);
  assert.doesNotMatch(source, /m_test_[A-Za-z0-9]/u);
  assert.match(source, /return_url/u);
  assert.match(source, /return_url_on_failure/u);
  assert.match(source, /allowFincodeTestRedirectUrl/u);
});

test("legacy checkout success page cannot claim success from query parameters", async () => {
  const source = await readFile(new URL("../src/pages/checkout/success.astro", import.meta.url), "utf8");
  assert.doesNotMatch(source, /searchParams|get\("session_id"\)|決済が完了しました/u);
  assert.match(source, /URLの値だけでは決済完了を判定しません/u);
});

test("TEST payment implementation contains no AWS, DynamoDB, Secrets Manager or entitlement mutation", async () => {
  const paths = [
    "../src/server/fincode/test/fincodeTestConfig.ts",
    "../src/server/fincode/test/fincodeTestHttpClient.ts",
    "../src/server/fincode/test/fincodeTestPayments.ts",
    "../src/server/fincode/test/fincodeTestHttpHandlers.ts",
  ];
  const source = (await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(source, /DynamoDB|SecretsManager|extra_voice_remaining|membership|quota|entitlement/u);
  assert.doesNotMatch(source, /api\.fincode\.jp(?!\/)/u);
  assert.match(source, /api\.test\.fincode\.jp/u);
});
