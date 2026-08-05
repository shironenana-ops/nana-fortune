import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/fincode-one-time-voice-dynamo-adapter-test/index.mjs";
await build({
  entryPoints: ["src/server/fincode/aws/dynamoOneTimeVoiceGrant.ts"],
  outfile,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const { DynamoFincodeOneTimeVoicePurchaseStore } = await import(
  `${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`
);
const purchase = Object.freeze({
  paymentDigest: "a".repeat(64),
  payloadFingerprint: "b".repeat(64),
  userReference: "user_TEST_ONLY_001",
  environment: "test",
  shopDigest: "c".repeat(64),
  product: "voice_single",
  amount: 300,
  state: "REGISTERED",
});

function store(sent, responses = [], diagnostics = []) {
  return new DynamoFincodeOneTimeVoicePurchaseStore({
    async send(command) {
      sent.push(command.input);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  }, {
    purchaseTableName: "FincodeOneTimeVoicePurchasesTest",
    usersTableName: "ShironeUsersTest",
    environment: "test",
  }, (code) => diagnostics.push(code));
}

test("registered purchase intent is a conditional, payment-digest keyed write", async () => {
  const sent = [];
  const result = await store(sent).createRegistered(purchase);
  assert.equal(result, "CREATED");
  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.equal(command.TableName, "FincodeOneTimeVoicePurchasesTest");
  assert.equal(command.ConditionExpression, "attribute_not_exists(payment_digest)");
  assert.equal(command.Item.payment_digest.S, purchase.paymentDigest);
  assert.equal(command.Item.product.S, "voice_single");
  assert.equal(command.Item.amount.N, "300");
  assert.equal(command.Item.processing_state.S, "REGISTERED");
});

test("atomic grant updates the purchase ledger and extra voice together", async () => {
  const sent = [];
  const result = await store(sent).grant({ purchase, completedAt: "2026-08-03T00:00:00.000Z" });
  assert.equal(result, "COMPLETED");
  assert.equal(sent.length, 1);
  const [ledger, user] = sent[0].TransactItems;
  assert.equal(ledger.Update.TableName, "FincodeOneTimeVoicePurchasesTest");
  assert.match(ledger.Update.ConditionExpression, /processing_state = :registered/u);
  assert.match(ledger.Update.ConditionExpression, /payload_fingerprint = :fingerprint/u);
  assert.match(ledger.Update.UpdateExpression, /processing_state = :completed/u);
  assert.equal(user.Update.TableName, "ShironeUsersTest");
  assert.equal(user.Update.UpdateExpression, "ADD extra_voice_remaining :one SET updated_at = :updatedAt");
  assert.equal(user.Update.ConditionExpression, "attribute_exists(user_id)");
  assert.equal(user.Update.ExpressionAttributeValues[":one"].N, "1");
});

test("a transaction failure returns no success and only an exact completed ledger can recover as duplicate", async () => {
  const cancellation = Object.assign(new Error("conditional"), { name: "TransactionCanceledException" });
  const sent = [];
  const diagnostics = [];
  const unavailable = await store(sent, [cancellation, { Item: undefined }], diagnostics)
    .grant({ purchase, completedAt: "2026-08-03T00:00:00.000Z" });
  assert.equal(unavailable, "RETRYABLE_FAILURE");
  assert.deepEqual(diagnostics, ["VOICE_DDB_TRANSACTION_CANCELED"]);

  const completedItem = {
    payment_digest: { S: purchase.paymentDigest },
    payload_fingerprint: { S: purchase.payloadFingerprint },
    user_reference: { S: purchase.userReference },
    environment: { S: purchase.environment },
    shop_digest: { S: purchase.shopDigest },
    product: { S: "voice_single" },
    amount: { N: "300" },
    processing_state: { S: "COMPLETED" },
  };
  const duplicate = await store([], [cancellation, { Item: completedItem }])
    .grant({ purchase, completedAt: "2026-08-03T00:00:00.000Z" });
  assert.equal(duplicate, "ALREADY_COMPLETED");
});

test("Dynamo failures emit only fixed diagnostic codes", async () => {
  for (const [name, expected] of [
    ["ValidationException", "VOICE_DDB_VALIDATION"],
    ["AccessDeniedException", "VOICE_DDB_ACCESS_DENIED"],
    ["ThrottlingException", "VOICE_DDB_THROTTLED"],
    ["InternalServerError", "VOICE_DDB_UNAVAILABLE"],
  ]) {
    const diagnostics = [];
    const failure = Object.assign(new Error("raw provider detail"), { name });
    assert.equal(await store([], [failure], diagnostics).grant({ purchase, completedAt: "2026-08-03T00:00:00.000Z" }), "RETRYABLE_FAILURE");
    assert.deepEqual(diagnostics, [expected]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /raw provider detail/u);
  }
});
