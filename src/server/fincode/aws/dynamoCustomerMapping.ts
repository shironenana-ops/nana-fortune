import { createHash } from "node:crypto";
import { GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { FincodeWebhookCustomerLookupResult, FincodeWebhookCustomerPort } from "../webhookPorts";
import { FincodeWebhookAwsError } from "./webhookAwsErrors";

type Sender = { send(command: unknown): Promise<unknown> };
type Item = Record<string, AttributeValue>;
const USER_REF = /^[A-Za-z0-9_-]{1,128}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const string = (item: Item, key: string) => item[key] && "S" in item[key] ? item[key].S : undefined;
const integer = (item: Item, key: string) => item[key] && "N" in item[key] && /^\d+$/u.test(item[key].N ?? "") ? Number(item[key].N) : undefined;

export class DynamoFincodeCustomerMapping implements FincodeWebhookCustomerPort {
  constructor(
    private readonly client: Sender,
    private readonly mappingTableName: string,
    private readonly usersTableName: string,
    private readonly environment: "staging" | "production",
  ) {}

  async findByOpaqueCustomerReference(customerReference: string): Promise<FincodeWebhookCustomerLookupResult> {
    if (!customerReference || customerReference.length > 256 || /[\r\n\0]/u.test(customerReference)) return { status: "CONFLICT" };
    const digest = createHash("sha256").update(customerReference, "utf8").digest("hex");
    try {
      const mapping = await this.client.send(new GetItemCommand({
        TableName: this.mappingTableName,
        Key: { customer_ref_digest: { S: digest } },
        ConsistentRead: true,
        ProjectionExpression: "customer_ref_digest, internal_user_id, environment, mapping_status, version",
      })) as { Item?: Item };
      if (!mapping.Item) return { status: "NOT_FOUND" };
      const userReference = string(mapping.Item, "internal_user_id");
      if (string(mapping.Item, "environment") !== this.environment || string(mapping.Item, "mapping_status") !== "ACTIVE" ||
          !userReference || !USER_REF.test(userReference) || (integer(mapping.Item, "version") ?? 0) < 1) return { status: "CONFLICT" };
      const user = await this.client.send(new GetItemCommand({
        TableName: this.usersTableName,
        Key: { user_id: { S: userReference } },
        ConsistentRead: true,
        ProjectionExpression: "user_id, membership_version, #plan, subscription_status, membership_period_key",
        ExpressionAttributeNames: { "#plan": "plan" },
      })) as { Item?: Item };
      if (!user.Item || string(user.Item, "user_id") !== userReference) return { status: "CONFLICT" };
      const version = integer(user.Item, "membership_version");
      const plan = string(user.Item, "plan");
      const subscriptionStatus = string(user.Item, "subscription_status");
      const periodKey = string(user.Item, "membership_period_key") ?? null;
      if (version === undefined || !["free", "light", "premium"].includes(plan ?? "") ||
          !["active", "inactive"].includes(subscriptionStatus ?? "") || (periodKey !== null && !PERIOD.test(periodKey))) return { status: "CONFLICT" };
      return { status: "FOUND", userReference, membershipSnapshot: {
        version, plan: plan as "free" | "light" | "premium",
        subscriptionStatus: subscriptionStatus as "active" | "inactive", periodKey,
      } };
    } catch {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_CUSTOMER_MAPPING_UNAVAILABLE");
    }
  }
}
