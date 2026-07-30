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
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";
const PERIOD_ID = fincode.createFincodePeriodId(PERIOD_START, PERIOD_END);

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
    routeKey: "POST /webhooks/fincode",
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

function activeLightCompletionPlan(overrides = {}) {
  return {
    decision: "ACTIVATE_SUBSCRIPTION",
    expectedMembership: {
      version: 0,
      plan: "free",
      subscriptionStatus: "inactive",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    },
    plan: "light",
    finalLedgerState: "COMPLETED",
    period: {
      source: "TRUSTED_MEMBERSHIP_SOURCE",
      sourceVersion: "fixture-v1",
      periodId: PERIOD_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    entitlementMutation: {
      kind: "SET_MEMBERSHIP",
      plan: "light",
      subscriptionStatus: "active",
      deepEnabled: false,
      monthlyVoiceLimit: 3,
      cancelAtPeriodEnd: false,
    },
    quotaMutation: {
      kind: "CREATE_PERIOD_ALLOWANCE",
      periodId: PERIOD_ID,
      lightLimit: 5,
      preserveExistingUsage: true,
    },
    billingMutation: { kind: "NONE" },
    resultCode: "ENTITLEMENT_APPLIED",
    ledgerOnly: false,
    ...overrides,
  };
}

function fakeDependencies(overrides = {}) {
  const calls = { reserve: [], fail: [], customer: [], plan: [], atomic: [], audit: [] };
  const dependencies = {
    boundary: boundary(),
    expectedSignature: SIGNATURE,
    retentionPolicy: { ttlSeconds: 3600, minimumTtlSeconds: 60, maximumTtlSeconds: 86400 },
    ledger: {
      async reserve(input) { calls.reserve.push(input); return "RESERVED"; },
      async fail(input) { calls.fail.push(input); },
    },
    customers: {
      async findByOpaqueCustomerReference(input) {
        calls.customer.push(input);
        return {
          status: "FOUND",
          userReference: "opaque-user-fixture",
          membershipSnapshot: { version: 0, plan: "free", subscriptionStatus: "inactive", currentPeriodStart: null, currentPeriodEnd: null },
        };
      },
    },
    completionPlanFactory(input) {
      calls.plan.push(input);
      return activeLightCompletionPlan({ decision: input.decision, expectedMembership: input.membershipSnapshot });
    },
    planResolver(planRef) { return planRef === PLAN ? "light" : null; },
    periodSource: { async resolve() { return { status: "RESOLVED", periodId: PERIOD_ID, periodStart: PERIOD_START, periodEnd: PERIOD_END, source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1" }; } },
    atomicCompletion: {
      async applyAndComplete(input) { calls.atomic.push(input); return "COMPLETED"; },
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

test("ACTIVE/RUNNINGはtrusted period未解決ならledger前に503へfail closedする", async () => {
  for (const periodSource of [
    undefined,
    { async resolve() { return { status: "NOT_AVAILABLE" }; } },
    { async resolve() { return { status: "UNAVAILABLE" }; } },
    { async resolve() { return { status: "RESOLVED", periodId: "bad", periodStart: PERIOD_START, periodEnd: PERIOD_END, source: "TRUSTED_MEMBERSHIP_SOURCE", sourceVersion: "fixture-v1" }; } },
  ]) {
    const fixture = fakeDependencies({ periodSource });
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.calls.reserve.length, 0);
  }
});

test("period conflictは409、period sourceへはdigestと明示planだけを渡す", async () => {
  let sourceInput;
  const conflict = fakeDependencies({ periodSource: { async resolve(input) { sourceInput = input; return { status: "CONFLICT" }; } } });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), conflict.dependencies)).statusCode, 409);
  assert.equal(conflict.calls.reserve.length, 0);
  assert.match(sourceInput.subscriptionDigest, /^[0-9a-f]{64}$/u);
  assert.match(sourceInput.customerDigest, /^[0-9a-f]{64}$/u);
  assert.equal(sourceInput.plan, "light");
  assert.equal(sourceInput.processDate, "2026/07/30 09:10:11.123");
  assert.doesNotMatch(JSON.stringify(sourceInput), new RegExp(`${CUSTOMER}|${SUBSCRIPTION}`));
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
        async fail(input) { fixture.calls.fail.push(input); },
      },
    });
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(body(response).receive, expectedReceive);
    assert.equal(fixture.calls.customer.length, 0);
    assert.equal(fixture.calls.atomic.length, 0);
  }
});

test("原子的完了Portの成功時だけ200になり、それ以外は固定409/503へfail closedする", async () => {
  for (const [atomicResult, expectedStatus] of [
    ["COMPLETED", 200],
    ["ALREADY_COMPLETED", 200],
    ["CONDITIONAL_CONFLICT", 409],
    ["UNAVAILABLE", 503],
    ["RETRYABLE_FAILURE", 503],
    ["UNKNOWN_RESULT", 503],
  ]) {
    const fixture = fakeDependencies({
      atomicCompletion: {
        async applyAndComplete(input) { fixture.calls.atomic.push(input); return atomicResult; },
      },
    });
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(fixture.calls.atomic.length, 1);
  }

  const thrown = fakeDependencies({
    atomicCompletion: { async applyAndComplete() { throw new Error("private transaction detail customer@example.invalid"); } },
  });
  const thrownResponse = await fincode.orchestrateFincodeWebhook(event(), thrown.dependencies);
  assert.equal(thrownResponse.statusCode, 503);
  assert.doesNotMatch(JSON.stringify([thrownResponse, thrown.calls.audit]), /private transaction|customer@example\.invalid/u);
});

test("原子的完了Portまたはreview済みplan factoryが未注入なら503で成功完了しない", async () => {
  for (const missing of ["atomicCompletion", "completionPlanFactory"]) {
    const fixture = fakeDependencies();
    delete fixture.dependencies[missing];
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(body(response), { receive: "1" });
    assert.equal(fixture.calls.atomic.length, 0);
    assert.equal(fixture.calls.fail.at(-1)?.retryableResultCode, "MUTATION_NOT_AVAILABLE");
  }
});

test("customer mapping未作成とrepository障害は503、mapping conflictは409、形式/環境不正は400", async () => {
  const missing = fakeDependencies({ customers: { async findByOpaqueCustomerReference() { return { status: "NOT_FOUND" }; } } });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), missing.dependencies)).statusCode, 503);
  assert.equal(missing.calls.atomic.length, 0);

  const conflict = fakeDependencies({ customers: { async findByOpaqueCustomerReference() { return { status: "CONFLICT" }; } } });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), conflict.dependencies)).statusCode, 409);
  assert.equal(conflict.calls.atomic.length, 0);

  const repositoryError = fakeDependencies({
    customers: { async findByOpaqueCustomerReference() { throw new Error("private repository marker customer@example.invalid"); } },
  });
  const repositoryResponse = await fincode.orchestrateFincodeWebhook(event(), repositoryError.dependencies);
  assert.equal(repositoryResponse.statusCode, 503);

  const ledgerError = fakeDependencies({
    ledger: {
      async reserve() { throw new Error("RequestId secret-provider-reference"); },
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

  const malformed = fakeDependencies();
  assert.equal((await fincode.orchestrateFincodeWebhook(
    event({ body: JSON.stringify(payload({ customer_id: "bad ref" })) }), malformed.dependencies,
  )).statusCode, 400);
  assert.equal(malformed.calls.reserve.length, 0);

  const wrongEnvironment = fakeDependencies();
  assert.equal((await fincode.orchestrateFincodeWebhook(
    event({ body: JSON.stringify(payload({ customer_id: `prod_${"b".repeat(24)}` })) }), wrongEnvironment.dependencies,
  )).statusCode, 400);
  assert.equal(wrongEnvironment.calls.reserve.length, 0);

  const serialized = JSON.stringify([
    repositoryError.calls.audit,
    ledgerError.calls.audit,
    repositoryResponse,
  ]);
  for (const forbidden of ["customer@example.invalid", "private repository marker", "RequestId", "secret-provider-reference", SHOP, PLAN, CUSTOMER, SUBSCRIPTION, SIGNATURE]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("同一eventを6回受けても原子的mutationは最大1回で、完了後の再送は200になる", async () => {
  let completed = false;
  const fixture = fakeDependencies({
    ledger: {
      async reserve(input) {
        fixture.calls.reserve.push(input);
        return completed ? "DUPLICATE_COMPLETED" : "RESERVED";
      },
      async fail(input) { fixture.calls.fail.push(input); },
    },
    atomicCompletion: {
      async applyAndComplete(input) {
        fixture.calls.atomic.push(input);
        completed = true;
        return "COMPLETED";
      },
    },
  });
  for (let index = 0; index < 6; index += 1) {
    const response = await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
    assert.equal(response.statusCode, 200);
  }
  assert.equal(fixture.calls.atomic.length, 1);
  assert.equal(fixture.calls.customer.length, 1);
  assert.equal(fixture.calls.fail.length, 0);
});

test("原子的完了失敗後の再送はcompleted duplicateにならず再試行される", async () => {
  const fixture = fakeDependencies({
    atomicCompletion: {
      async applyAndComplete(input) { fixture.calls.atomic.push(input); return "RETRYABLE_FAILURE"; },
    },
  });
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies)).statusCode, 503);
  }
  assert.equal(fixture.calls.atomic.length, 2);
  assert.equal(fixture.calls.fail.length, 2);
});

test("ledger/原子的完了Portへraw provider識別子・payload・signatureを渡さない", async () => {
  const fixture = fakeDependencies();
  await fincode.orchestrateFincodeWebhook(event(), fixture.dependencies);
  assert.equal(fixture.calls.reserve.length, 1);
  assert.deepEqual(Object.keys(fixture.calls.reserve[0]).sort(), ["payloadFingerprint", "semanticEventKey", "ttlSeconds"]);
  assert.match(fixture.calls.reserve[0].semanticEventKey, /^[0-9a-f]{64}$/u);
  assert.match(fixture.calls.reserve[0].payloadFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(fixture.calls.atomic.length, 1);
  assert.deepEqual(Object.keys(fixture.calls.atomic[0]).sort(), [
    "completedAt", "completionPlan", "correlationDigest", "expectedLedgerState", "normalizedEvent",
    "payloadFingerprint", "retentionTtlSeconds", "semanticEventKey", "userReference",
  ]);
  assert.deepEqual(Object.keys(fixture.calls.atomic[0].normalizedEvent).sort(), ["environment", "eventType", "status"]);
  assert.match(fixture.calls.atomic[0].correlationDigest, /^[0-9a-f]{64}$/u);
  const serialized = JSON.stringify([fixture.calls.reserve, fixture.calls.fail, fixture.calls.atomic, fixture.calls.audit]);
  for (const raw of [SHOP, PLAN, CUSTOMER, SUBSCRIPTION, SIGNATURE, JSON.stringify(payload())]) {
    assert.doesNotMatch(serialized, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("plan変更とINCOMPLETEは権利・quotaを変更せず原子的にMANUAL_REVIEWを確定できる", async () => {
  const manualReviewPlan = (decision, resultCode, billingKind) => ({
    decision,
    expectedMembership: { version: 2, plan: "light", subscriptionStatus: "active", currentPeriodStart: "2026-07-01T00:00:00.000Z", currentPeriodEnd: "2026-08-01T00:00:00.000Z" },
    plan: "UNCHANGED",
    finalLedgerState: "MANUAL_REVIEW",
    entitlementMutation: { kind: "NONE" },
    quotaMutation: { kind: "NONE" },
    billingMutation: { kind: billingKind },
    resultCode,
    ledgerOnly: false,
  });

  const planChange = fakeDependencies({
    completionPlanFactory(input) {
      planChange.calls.plan.push(input);
      return manualReviewPlan(input.decision, "PLAN_CHANGE_MANUAL_REVIEW", "RECORD_MANUAL_REVIEW");
    },
  });
  assert.equal((await fincode.orchestrateFincodeWebhook(event(), planChange.dependencies)).statusCode, 200);
  assert.equal(planChange.calls.atomic[0].completionPlan.entitlementMutation.kind, "NONE");
  assert.equal(planChange.calls.atomic[0].completionPlan.quotaMutation.kind, "NONE");

  for (const userReference of ["new-free-user", "existing-active-user"]) {
    const incomplete = fakeDependencies({
      customers: { async findByOpaqueCustomerReference() {
        return {
          status: "FOUND",
          userReference,
          membershipSnapshot: userReference === "existing-active-user"
            ? { version: 4, plan: "light", subscriptionStatus: "active", currentPeriodStart: "2026-07-01T00:00:00.000Z", currentPeriodEnd: "2026-08-01T00:00:00.000Z" }
            : { version: 0, plan: "free", subscriptionStatus: "inactive", currentPeriodStart: null, currentPeriodEnd: null },
        };
      } },
      completionPlanFactory(input) {
        incomplete.calls.plan.push(input);
        return {
          ...manualReviewPlan(input.decision, "INCOMPLETE_RECORDED", "RECORD_INCOMPLETE"),
          expectedMembership: input.membershipSnapshot,
        };
      },
    });
    const incompleteEvent = event({ body: JSON.stringify(payload({ status: "INCOMPLETE", event: "subscription.card.update" })) });
    assert.equal((await fincode.orchestrateFincodeWebhook(incompleteEvent, incomplete.dependencies)).statusCode, 200);
    assert.equal(incomplete.calls.atomic[0].completionPlan.entitlementMutation.kind, "NONE");
    assert.equal(incomplete.calls.atomic[0].completionPlan.quotaMutation.kind, "NONE");
  }
});

test("原子的完了planはtransactionに必要な安全な値を表現し不正shapeを拒否する", () => {
  const fixturePlan = activeLightCompletionPlan();
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan(fixturePlan), true);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, ledgerOnly: true }), false);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, quotaMutation: { kind: "CREATE_PERIOD_ALLOWANCE", periodId: "f".repeat(64), lightLimit: 5, preserveExistingUsage: true } }), false);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, period: { ...fixturePlan.period, periodId: "f".repeat(64) } }), false);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, expectedMembership: { version: 2, plan: "light", subscriptionStatus: "active", currentPeriodStart: null, currentPeriodEnd: null } }), false);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, resultCode: "UNKNOWN" }), false);
  assert.equal(fincode.isFincodeWebhookAtomicCompletionPlan({ ...fixturePlan, rawPlanId: PLAN }), false);
});

test("AWS SDK・実adapter・秘密値・production接続を追加せずPort境界を保つ", () => {
  const sources = [
    "src/server/fincode/webhookHttpAdapter.ts",
    "src/server/fincode/webhookPorts.ts",
    "src/server/fincode/webhookOrchestrator.ts",
  ].map((path) => fs.readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /@aws-sdk|DynamoDBClient|LambdaClient|fetch\s*\(|https?:\/\//u);
  assert.doesNotMatch(sources, /PutItem|UpdateItem|TransactWrite|SecretsManager/u);
  assert.doesNotMatch(sources, /FincodeWebhookEntitlementWriterPort|ledger\.complete|\.complete\(\{\s*\.\.\.digestIdentity/u);
  assert.match(sources, /FincodeWebhookAtomicCompletionPort/);
});
