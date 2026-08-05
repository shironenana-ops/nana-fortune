import { createHash } from "node:crypto";
import { GetItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { FincodeTestLightIntentPort, FincodeTestLightPurchaseIntent } from "./fincodeTestLightCheckout";

type Sender = { send(command: unknown): Promise<unknown> };
type Item = Record<string, AttributeValue>;

const text = (item: Item, key: string): string | undefined => item[key] && "S" in item[key] ? item[key].S : undefined;
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function parse(item: Item | undefined): FincodeTestLightPurchaseIntent | null {
  if (!item) return null;
  const amount = item.expected_amount && "N" in item.expected_amount ? Number(item.expected_amount.N) : NaN;
  if (
    text(item, "environment") !== "staging"
    || text(item, "mapping_status") !== "ACTIVE"
    || text(item, "checkout_schema_version") !== "fincode-light-browser-e2e-v1"
    || text(item, "expected_product") !== "light"
    || text(item, "expected_billing_type") !== "subscription"
    || amount !== 980
  ) return null;
  const id = text(item, "purchase_intent_id");
  const userId = text(item, "internal_user_id");
  const customerId = text(item, "customer_reference");
  const planReference = text(item, "expected_plan_reference");
  if (!id || !userId || !customerId || !planReference) return null;
  return { id, userId, customerId, planReference, product: "light", amount: 980, billingType: "subscription" };
}

export class DynamoFincodeTestLightIntentStore implements FincodeTestLightIntentPort {
  constructor(private readonly client: Sender, private readonly tableName: string) {}

  async prepare(intent: FincodeTestLightPurchaseIntent): Promise<"READY" | "CONFLICT" | "UNAVAILABLE"> {
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { customer_ref_digest: { S: digest(intent.customerId) } },
        ConditionExpression: "attribute_not_exists(customer_ref_digest) OR (internal_user_id = :user AND environment = :environment AND mapping_status = :active)",
        UpdateExpression: "SET internal_user_id=:user, environment=:environment, mapping_status=:active, #version=:version, customer_reference=:customer, checkout_schema_version=:schema, purchase_intent_id=:intent, expected_product=:product, expected_amount=:amount, expected_billing_type=:billing, expected_plan_reference=:plan, checkout_state=:prepared",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ":user": { S: intent.userId }, ":environment": { S: "staging" }, ":active": { S: "ACTIVE" },
          ":version": { N: "1" }, ":customer": { S: intent.customerId }, ":schema": { S: "fincode-light-browser-e2e-v1" },
          ":intent": { S: intent.id }, ":product": { S: intent.product }, ":amount": { N: String(intent.amount) },
          ":billing": { S: intent.billingType }, ":plan": { S: intent.planReference }, ":prepared": { S: "PREPARED" },
        },
      }));
      return "READY";
    } catch (error) {
      return (error as { name?: string })?.name === "ConditionalCheckFailedException" ? "CONFLICT" : "UNAVAILABLE";
    }
  }

  async find(customerId: string): Promise<FincodeTestLightPurchaseIntent | null> {
    try {
      const response = await this.client.send(new GetItemCommand({
        TableName: this.tableName,
        Key: { customer_ref_digest: { S: digest(customerId) } },
        ConsistentRead: true,
        ProjectionExpression: "internal_user_id, environment, mapping_status, #version, customer_reference, checkout_schema_version, purchase_intent_id, expected_product, expected_amount, expected_billing_type, expected_plan_reference, checkout_state",
        ExpressionAttributeNames: { "#version": "version" },
      })) as { Item?: Item };
      return parse(response.Item);
    } catch {
      return null;
    }
  }

  async markSubmitted(intent: FincodeTestLightPurchaseIntent, subscriptionId: string): Promise<"SUBMITTED" | "CONFLICT" | "UNAVAILABLE"> {
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { customer_ref_digest: { S: digest(intent.customerId) } },
        ConditionExpression: "internal_user_id=:user AND environment=:environment AND mapping_status=:active AND purchase_intent_id=:intent AND expected_plan_reference=:plan",
        UpdateExpression: "SET checkout_state=:submitted, subscription_reference=:subscription",
        ExpressionAttributeValues: {
          ":user": { S: intent.userId }, ":environment": { S: "staging" }, ":active": { S: "ACTIVE" },
          ":intent": { S: intent.id }, ":plan": { S: intent.planReference }, ":submitted": { S: "SUBMITTED" },
          ":subscription": { S: subscriptionId },
        },
      }));
      return "SUBMITTED";
    } catch (error) {
      return (error as { name?: string })?.name === "ConditionalCheckFailedException" ? "CONFLICT" : "UNAVAILABLE";
    }
  }
}
