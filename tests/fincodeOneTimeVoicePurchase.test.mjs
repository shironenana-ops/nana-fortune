import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/fincode-one-time-voice-purchase-test/index.mjs";
await build({
  entryPoints: ["src/server/fincode/oneTimeVoicePurchase.ts"],
  outfile,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const oneTime = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);

const payment = Object.freeze({
  environment: "test",
  shopReference: "s_TESTSHOP123",
  paymentReference: "o_TESTPAYMENT123",
  amount: 300,
  payType: "Card",
  jobCode: "CAPTURE",
  status: "CAPTURED",
});
const completedAt = "2026-08-03T00:00:00.000Z";

function purchase() {
  return oneTime.createFincodeOneTimeVoicePurchaseIntent({
    environment: payment.environment,
    shopReference: payment.shopReference,
    paymentReference: payment.paymentReference,
    userReference: "user_TEST_ONLY_001",
  });
}

function ports(stored = purchase()) {
  let grants = 0;
  return {
    intents: {
      async createRegistered() { return "CREATED"; },
      async findByPaymentDigest(digest) { return digest === stored.paymentDigest ? stored : null; },
    },
    grants: {
      async grant({ purchase: intent }) {
        if (stored.state === "COMPLETED") return "ALREADY_COMPLETED";
        assert.equal(intent.userReference, "user_TEST_ONLY_001");
        grants += 1;
        stored = { ...stored, state: "COMPLETED" };
        return "COMPLETED";
      },
    },
    count: () => grants,
  };
}

test("captured 300-yen voice_single payment grants exactly one extra voice", async () => {
  const fixture = ports();
  const result = await oneTime.grantFincodeOneTimeVoicePurchase({ payment, ...fixture, completedAt });
  assert.equal(result, "COMPLETED");
  assert.equal(fixture.count(), 1);
});

test("ten duplicate deliveries leave the one-time grant at one mutation", async () => {
  const fixture = ports();
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    oneTime.grantFincodeOneTimeVoicePurchase({ payment, ...fixture, completedAt }),
  ));
  assert.equal(results.filter((result) => result === "COMPLETED").length, 1);
  assert.equal(results.filter((result) => result === "ALREADY_COMPLETED").length, 9);
  assert.equal(fixture.count(), 1);
});

test("failed or mismatched provider confirmation cannot grant", async () => {
  for (const mismatch of [
    { status: "FAILED" }, { amount: 301 }, { amount: 299 }, { payType: "Paypay" },
    { jobCode: "AUTH" }, { environment: "staging" }, { shopReference: "s_OTHER_SHOP" },
  ]) {
    const fixture = ports();
    const result = await oneTime.grantFincodeOneTimeVoicePurchase({
      payment: { ...payment, ...mismatch }, intents: fixture.intents, grants: fixture.grants, completedAt,
    });
    assert.equal(result, "REJECTED");
    assert.equal(fixture.count(), 0);
  }
});

test("unknown mapping and retryable persistence failures mutate no entitlement", async () => {
  const unknown = await oneTime.grantFincodeOneTimeVoicePurchase({
    payment,
    intents: { async createRegistered() { return "CREATED"; }, async findByPaymentDigest() { return null; } },
    grants: { async grant() { throw new Error("must not run"); } },
    completedAt,
  });
  assert.equal(unknown, "REJECTED");

  const unavailable = await oneTime.grantFincodeOneTimeVoicePurchase({
    payment,
    intents: { async createRegistered() { return "CREATED"; }, async findByPaymentDigest() { throw new Error("temporary"); } },
    grants: { async grant() { throw new Error("must not run"); } },
    completedAt,
  });
  assert.equal(unavailable, "RETRYABLE_FAILURE");
});

test("purchase intent is payment-bound, opaque, and has no client supplied amount or user override", () => {
  const intent = purchase();
  assert.equal(intent.product, "voice_single");
  assert.equal(intent.amount, 300);
  assert.equal(intent.state, "REGISTERED");
  assert.match(intent.paymentDigest, /^[0-9a-f]{64}$/u);
  assert.match(intent.payloadFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(intent.shopDigest, /^[0-9a-f]{64}$/u);
  assert.throws(() => oneTime.createFincodeOneTimeVoicePurchaseIntent({
    environment: "test", shopReference: payment.shopReference, paymentReference: payment.paymentReference, userReference: "not an opaque reference",
  }));
});

test("the registered payment is not released until its server-side purchase intent is durable", async () => {
  const calls = [];
  const unavailable = await oneTime.registerFincodeOneTimeVoicePurchase({
    environment: "test",
    userReference: "user_TEST_ONLY_001",
    payments: { async register() { calls.push("payment"); return { shopReference: payment.shopReference, paymentReference: payment.paymentReference }; } },
    intents: {
      async createRegistered() { calls.push("intent"); return "UNAVAILABLE"; },
      async findByPaymentDigest() { return null; },
    },
  });
  assert.deepEqual(calls, ["payment", "intent"]);
  assert.deepEqual(unavailable, { status: "UNAVAILABLE" });

  const registered = await oneTime.registerFincodeOneTimeVoicePurchase({
    environment: "test",
    userReference: "user_TEST_ONLY_001",
    payments: { async register() { return { shopReference: payment.shopReference, paymentReference: payment.paymentReference }; } },
    intents: {
      async createRegistered() { return "CREATED"; },
      async findByPaymentDigest() { return null; },
    },
  });
  assert.deepEqual(registered, { status: "REGISTERED", paymentReference: payment.paymentReference });
});

test("one-time grant implementation has no HTTP, browser storage, or provider secret handling", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/server/fincode/oneTimeVoicePurchase.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|Authorization|SECRET|API_KEY/u);
  assert.match(source, /provider-verified capture/u);
});
