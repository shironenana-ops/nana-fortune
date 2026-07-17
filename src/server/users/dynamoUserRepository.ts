import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import type { TrustedMembershipRecord, UserRepository } from "./userRepository";

type DynamoSender = { send(command: GetItemCommand): Promise<{ Item?: Record<string, AttributeValue> }> };

const FIELD_NAMES = {
  "#plan": "plan",
  "#status": "subscription_status",
  "#deep": "deep_enabled",
  "#voiceLimit": "monthly_voice_limit",
  "#voiceUsed": "monthly_voice_used",
  "#extraVoice": "extra_voice_remaining",
  "#cancel": "cancel_at_period_end",
  "#periodEnd": "current_period_end",
};

function fromAttribute(value?: AttributeValue): unknown {
  if (!value || value.NULL) return undefined;
  if ("S" in value) return value.S;
  if ("N" in value) return value.N;
  if ("BOOL" in value) return value.BOOL;
  return undefined;
}

function whitelist(item: Record<string, AttributeValue>): TrustedMembershipRecord {
  return {
    plan: fromAttribute(item.plan),
    subscription_status: fromAttribute(item.subscription_status),
    deep_enabled: fromAttribute(item.deep_enabled),
    monthly_voice_limit: fromAttribute(item.monthly_voice_limit),
    monthly_voice_used: fromAttribute(item.monthly_voice_used),
    extra_voice_remaining: fromAttribute(item.extra_voice_remaining),
    cancel_at_period_end: fromAttribute(item.cancel_at_period_end),
    current_period_end: fromAttribute(item.current_period_end),
  };
}

export class DynamoUserRepository implements UserRepository {
  constructor(private readonly client: DynamoSender, private readonly tableName: string) {
    if (!tableName) throw new ServerFoundationError("USERS_TABLE_NOT_CONFIGURED");
  }

  async findMembershipByUserId(userId: string): Promise<TrustedMembershipRecord | null> {
    try {
      const result = await this.client.send(new GetItemCommand({
        TableName: this.tableName,
        Key: { user_id: { S: userId } },
        ProjectionExpression: Object.keys(FIELD_NAMES).join(", "),
        ExpressionAttributeNames: FIELD_NAMES,
        ConsistentRead: false,
      }));
      return result.Item ? whitelist(result.Item) : null;
    } catch (error) {
      if (error instanceof ServerFoundationError) throw error;
      throw new ServerFoundationError("USER_STORE_UNAVAILABLE", { cause: error });
    }
  }
}

export function createDynamoUserRepository(env: NodeJS.ProcessEnv = process.env): UserRepository {
  const tableName = env.USERS_TABLE_NAME ?? "";
  if (!tableName) throw new ServerFoundationError("USERS_TABLE_NOT_CONFIGURED");
  return new DynamoUserRepository(new DynamoDBClient({}), tableName);
}
