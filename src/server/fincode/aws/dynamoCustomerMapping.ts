import { createHash } from "node:crypto";
import { GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { FincodeWebhookCustomerLookupResult, FincodeWebhookCustomerPort } from "../webhookPorts";
import { parseFincodeMembershipRecordV1 } from "../membershipSchema";
import { FincodeWebhookAwsError } from "./webhookAwsErrors";

type Sender = { send(command: unknown): Promise<unknown> };
type Item = Record<string, AttributeValue>;
// Canonical auth uses normalized email addresses as user_id. Keep the accepted
// character set bounded while allowing the staging/production auth contract.
const USER_REF = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u;
const string = (item: Item, key: string) => item[key] && "S" in item[key] ? item[key].S : undefined;
const integer = (item: Item, key: string) => item[key] && "N" in item[key] && /^\d+$/u.test(item[key].N ?? "") ? Number(item[key].N) : undefined;
const boolean = (item: Item, key: string) => item[key] && "BOOL" in item[key] ? item[key].BOOL : undefined;

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
        ProjectionExpression: "user_id, membership_schema_version, membership_version, #plan, subscription_status, deep_enabled, monthly_voice_limit, monthly_voice_used, extra_voice_remaining, cancel_at_period_end, current_period_start, current_period_end, membership_source, membership_updated_at",
        ExpressionAttributeNames: { "#plan": "plan" },
      })) as { Item?: Item };
      if (!user.Item || string(user.Item, "user_id") !== userReference) return { status: "CONFLICT" };
      const membership = parseFincodeMembershipRecordV1({
        membership_schema_version: string(user.Item, "membership_schema_version"),
        membership_version: integer(user.Item, "membership_version"),
        plan: string(user.Item, "plan"), subscription_status: string(user.Item, "subscription_status"),
        deep_enabled: boolean(user.Item, "deep_enabled"), monthly_voice_limit: integer(user.Item, "monthly_voice_limit"),
        monthly_voice_used: integer(user.Item, "monthly_voice_used"), extra_voice_remaining: integer(user.Item, "extra_voice_remaining"),
        cancel_at_period_end: boolean(user.Item, "cancel_at_period_end"),
        current_period_start: string(user.Item, "current_period_start") ?? null,
        current_period_end: string(user.Item, "current_period_end") ?? null,
        membership_source: string(user.Item, "membership_source"), membership_updated_at: string(user.Item, "membership_updated_at"),
      });
      if (!membership) return { status: "CONFLICT" };
      return { status: "FOUND", userReference, membershipSnapshot: {
        version: membership.membershipVersion, plan: membership.plan, subscriptionStatus: membership.subscriptionStatus,
        currentPeriodStart: membership.currentPeriodStart, currentPeriodEnd: membership.currentPeriodEnd,
      } };
    } catch {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_CUSTOMER_MAPPING_UNAVAILABLE");
    }
  }
}
