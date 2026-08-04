import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const outfile = "dist/fincode-test-light-dynamo-test/index.mjs";
await build({ entryPoints: ["src/server/fincode/test/fincodeTestLightDynamo.ts"], outfile, bundle: true, packages: "external", format: "esm", platform: "node", target: "node22", logLevel: "silent" });
const { DynamoFincodeTestLightIntentStore } = await import(`${new URL(`../${outfile}`, import.meta.url).href}?test=${Date.now()}`);
const intent = { id: "pi_fixture", userId: "ui@staging.invalid", customerId: "stg_customer_fixture", planReference: "pl_light", product: "light", amount: 980, billingType: "subscription" };

test("Light intent uses the existing customer mapping table with conditional writes", async () => {
  const commands = [];
  const store = new DynamoFincodeTestLightIntentStore({ send: async (command) => { commands.push(command); return {}; } }, "mapping-staging");
  assert.equal(await store.prepare(intent), "READY");
  const input = commands[0].input;
  assert.equal(input.TableName, "mapping-staging");
  assert.match(input.ConditionExpression, /internal_user_id/u);
  assert.equal(input.ExpressionAttributeValues[":product"].S, "light");
  assert.equal(input.ExpressionAttributeValues[":amount"].N, "980");
  assert.notEqual(input.Key.customer_ref_digest.S, intent.customerId);
});

test("Light intent reads exact canonical mapping fields and marks only the same intent submitted", async () => {
  const commands = [];
  const item = {
    internal_user_id: { S: intent.userId }, environment: { S: "staging" }, mapping_status: { S: "ACTIVE" }, version: { N: "1" },
    customer_reference: { S: intent.customerId }, checkout_schema_version: { S: "fincode-light-browser-e2e-v1" }, purchase_intent_id: { S: intent.id },
    expected_product: { S: "light" }, expected_amount: { N: "980" }, expected_billing_type: { S: "subscription" }, expected_plan_reference: { S: intent.planReference }, checkout_state: { S: "PREPARED" },
  };
  const store = new DynamoFincodeTestLightIntentStore({ send: async (command) => { commands.push(command); return command.constructor.name === "GetItemCommand" ? { Item: item } : {}; } }, "mapping-staging");
  assert.deepEqual(await store.find(intent.customerId), intent);
  assert.equal(await store.markSubmitted(intent, "su_fixture"), "SUBMITTED");
  assert.match(commands.at(-1).input.ConditionExpression, /purchase_intent_id/u);
});
