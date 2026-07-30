import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/fincode-webhook-http-adapter-test/index.mjs";
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

const SIGNATURE = "fixture-static-value-not-a-secret";
const SHOP = "s_abcdefghijk";
const PLAN = "pl_fixture_light";
const CUSTOMER = `stg_${"a".repeat(24)}`;
const SUBSCRIPTION = "su_fixture_subscription";

function payload(overrides = {}) {
  return {
    shop_id: SHOP,
    subscription_id: SUBSCRIPTION,
    plan_id: PLAN,
    customer_id: CUSTOMER,
    status: "ACTIVE",
    process_date: "2026/07/30 09:10:11.123",
    start_date: "2026/08/01 00:00:00.000",
    stop_date: null,
    pay_type: "Card",
    event: "subscription.card.regist",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    version: "2.0",
    headers: { "content-type": "application/json", "fincode-signature": SIGNATURE },
    body: JSON.stringify(payload()),
    isBase64Encoded: false,
    requestContext: { requestId: "fixture-request", http: { method: "POST" } },
    ...overrides,
  };
}

function boundary(overrides = {}) {
  return {
    enabled: true,
    environment: "staging",
    customerReferencePrefix: "stg_",
    allowedShopRefs: new Set([SHOP]),
    allowedPlanRefs: new Set([PLAN]),
    productionIdentifiers: new Set(["s_prod0000000"]),
    ...overrides,
  };
}

function fakeDependencies(overrides = {}) {
  const calls = { reserve: [], complete: [], fail: [], customer: [], writer: [], audit: [] };
  const dependencies = {
    boundary: boundary(),
    expectedSignature: SIGNATURE,
    retentionPolicy: { ttlSeconds: 3600, minimumTtlSeconds: 60, maximumTtlSeconds: 86400 },
    ledger: {
      async reserve(input) { calls.reserve.push(input); return "RESERVED"; },
      async complete(input) { calls.complete.push(input); },
      async fail(input) { calls.fail.push(input); },
    },
    customers: {
      async findByOpaqueCustomerReference(input) {
        calls.customer.push(input);
        return { userReference: "opaque-user-fixture" };
      },
    },
    entitlementWriter: {
      async applyDecision(input) { calls.writer.push(input); },
    },
    auditSink(line) { calls.audit.push(line); },
    now: () => 1000,
    ...overrides,
  };
  return { calls, dependencies };
}

function body(response) {
  return JSON.parse(response.body);
}

test("HTTP v2 adapterはraw/base64 bodyを同じ文字列へ復元し固定レスポンスにCORSを含めない", () => {
  const raw = event();
  const adaptedRaw = fincode.adaptFincodeWebhookHttpEvent(raw);
  const encoded = event({ body: Buffer.from(raw.body, "utf8").toString("base64"), isBase64Encoded: true });
  const adaptedEncoded = fincode.adaptFincodeWebhookHttpEvent(encoded);
  assert.equal(adaptedRaw.rawBody, raw.body);
  assert.equal(adaptedEncoded.rawBody, raw.body);
  assert.deepEqual(fincode.fincodeWebhookAcknowledgedResponse(), {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: '{"receive":"0"}',
  });
  for (const response of [
    fincode.fincodeWebhookRetryResponse(),
    fincode.fincodeWebhookRejectedResponse(400),
    fincode.fincodeWebhookRejectedResponse(401),
    fincode.fincodeWebhookRejectedResponse(409),
  ]) {
    assert.equal("access-control-allow-origin" in response.headers, false);
  }
});

test("HTTP adapterはmethod/content-type/body/base64/UTF-8/64KiBをfail closedで拒否する", () => {
  const errors = [
    [event({ requestContext: { requestId: "x", http: { method: "GET" } } }), "WEBHOOK_METHOD_INVALID"],
    [event({ headers: { "content-type": "text/plain", "fincode-signature": SIGNATURE } }), "WEBHOOK_CONTENT_TYPE_INVALID"],
    [event({ headers: { "Content-Type": "application/json", "content-type": "application/json", "fincode-signature": SIGNATURE } }), "WEBHOOK_CONTENT_TYPE_INVALID"],
    [event({ body: undefined }), "WEBHOOK_JSON_INVALID"],
    [event({ body: "not base64", isBase64Encoded: true }), "WEBHOOK_BODY_ENCODING_INVALID"],
    [event({ body: "/w==", isBase64Encoded: true }), "WEBHOOK_BODY_ENCODING_INVALID"],
    [event({ body: "x".repeat(fincode.FINCODE_WEBHOOK_MAX_BODY_BYTES + 1) }), "WEBHOOK_BODY_TOO_LARGE"],
    [event({ body: Buffer.alloc(fincode.FINCODE_WEBHOOK_MAX_BODY_BYTES + 1).toString("base64"), isBase64Encoded: true }), "WEBHOOK_BODY_TOO_LARGE"],
  ];
  for (const [input, expected] of errors) {
    assert.throws(() => fincode.adaptFincodeWebhookHttpEvent(input), (error) => error?.code === expected);
  }
});

test("kill switchはtransportより先、署名はJSONより先、schema/environmentはledgerより先", async () => {
  const disabled = fakeDependencies({ boundary: boundary({ enabled: false }) });
  const disabledResponse = await fincode.orchestrateFincodeWebhook({ totally: "invalid" }, disabled.dependencies);
  assert.equal(disabledResponse.statusCode, 503);
  assert.equal(disabled.calls.reserve.length, 0);

  const badSignature = fakeDependencies();
  const signatureResponse = await fincode.orchestrateFincodeWebhook(
    event({ body: "{bad json", headers: { "content-type": "application/json", "fincode-signature": "wrong" } }),
    badSignature.dependencies,
  );
  assert.equal(signatureResponse.statusCode, 401);
  assert.equal(badSignature.calls.reserve.length, 0);

  const badEnvironment = fakeDependencies();
  const environmentResponse = await fincode.orchestrateFincodeWebhook(
    event({ body: JSON.stringify(payload({ plan_id: "pl_unknown" })) }),
    badEnvironment.dependencies,
  );
  assert.equal(environmentResponse.statusCode, 400);
  assert.equal(badEnvironment.calls.reserve.length, 0);
});

test("completed duplicateだけ200、in-progress/unavailableは503、fingerprint conflictは409", async () => {
  for (const [reservation, expectedStatus, expectedReceive] of [
    ["DUPLICATE_COMPLETED", 200, "0"],
    ["DUPLICATE_IN_PROGRESS", 503, "1"],
    ["UNAVAILABLE", 503, "1"],
    ["CONFLICT", 409, "1"],
  ]) {
    const fixture = fakeDependencies({
      ledger: {
        async reserve(input) { fixture.calls.reserve.push(input); return reservation; },
        async complete(input) { fixture.calls.complete.push(input); },
        async fail(input) { fixture.calls.fail.push(input); },
      },
    });
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(body(response).receive, expectedReceive);
    assert.equal(fixture.calls.customer.length, 0);
    assert.equal(fixture.calls.writer.length, 0);
  }
});

test("new eventはcustomer照合後もmutation不可なら503でledgerを完了しない", async () => {
  const fixture = fakeDependencies();
  const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(body(response), { receive: "1" });
  assert.equal(fixture.calls.customer.length, 1);
  assert.equal(fixture.calls.writer.length, 0);
  assert.equal(fixture.calls.complete.length, 0);
  assert.equal(fixture.calls.fail.length, 1);
  assert.equal(fixture.calls.fail[0].retryableResultCode, "MUTATION_NOT_AVAILABLE");
});

test("customer missingは400、repository/ledger例外とretention不備は503で内部情報を漏らさない", async () => {
  const missing = fakeDependencies({ customers: { async findByOpaqueCustomerReference() { return null; } } });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), missing.dependencies)).statusCode, 400);

  const repositoryError = fakeDependencies({
    customers: { async findByOpaqueCustomerReference() { throw new Error("arn:aws:dynamodb:region:000000000000:table/private customer@example.invalid"); } },
  });
  const repositoryResponse = await fincode.orchestrateFincodeWebhook(event(), repositoryError.dependencies);
  assert.equal(repositoryResponse.statusCode, 503);

  const ledgerError = fakeDependencies({
    ledger: {
      async reserve() { throw new Error("RequestId secret-provider-reference"); },
      async complete() {},
      async fail() {},
    },
  });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), ledgerError.dependencies)).statusCode, 503);

  for (const retentionPolicy of [
    { ttlSeconds: 0, minimumTtlSeconds: 1, maximumTtlSeconds: 2 },
    { ttlSeconds: 1.5, minimumTtlSeconds: 1, maximumTtlSeconds: 2 },
    { ttlSeconds: 10, minimumTtlSeconds: 20, maximumTtlSeconds: 30 },
  ]) {
    const invalid = fakeDependencies({ retentionPolicy });
    assert.equal((await fincode.orchestrateFincodeWebhook(event(), invalid.dependencies)).statusCode, 503);
    assert.equal(invalid.calls.reserve.length, 0);
  }

  const serialized = JSON.stringify([
    repositoryError.calls.audit,
    ledgerError.calls.audit,
    repositoryResponse,
  ]);
  for (const forbidden of ["customer@example.invalid", "000000000000", "RequestId", "secret-provider-reference", SHOP, PLAN, CUSTOMER, SUBSCRIPTION, SIGNATURE]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("同一requestを6回受けても未実装writerを呼ばず成功扱いにもcompletedにもならない", async () => {
  const fixture = fakeDependencies();
  for (let index = 0; index < 6; index += 1) {
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, 503);
  }
  assert.equal(fixture.calls.writer.length, 0);
  assert.equal(fixture.calls.complete.length, 0);
  assert.equal(fixture.calls.fail.length, 6);
});

test("ledger Portへ渡るのはdigestとTTLだけでprovider識別子やpayloadを含まない", async () => {
  const fixture = fakeDependencies();
  await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
  assert.equal(fixture.calls.reserve.length, 1);
  assert.deepEqual(Object.keys(fixture.calls.reserve[0]).sort(), ["payloadFingerprint", "semanticEventKey", "ttlSeconds"]);
  assert.match(fixture.calls.reserve[0].semanticEventKey, /^[0-9a-f]{64}$/u);
  assert.match(fixture.calls.reserve[0].payloadFingerprint, /^[0-9a-f]{64}$/u);
  const serialized = JSON.stringify([fixture.calls.reserve, fixture.calls.fail, fixture.calls.audit]);
  for (const raw of [SHOP, PLAN, CUSTOMER, SUBSCRIPTION, SIGNATURE, JSON.stringify(payload())]) {
    assert.doesNotMatch(serialized, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("AWS SDK・実adapter・秘密値・production接続を追加せずPort境界を保つ", () => {
  const sources = [
    "src/server/fincode/webhookHttpAdapter.ts",
    "src/server/fincode/webhookPorts.ts",
    "src/server/fincode/webhookOrchestrator.ts",
  ].map((path) => fs.readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /@aws-sdk|DynamoDBClient|LambdaClient|fetch\s*\(|https?:\/\//u);
  assert.doesNotMatch(sources, /PutItem|UpdateItem|TransactWrite|SecretsManager/u);
  assert.match(sources, /mutationAllowed !== true/);
});
