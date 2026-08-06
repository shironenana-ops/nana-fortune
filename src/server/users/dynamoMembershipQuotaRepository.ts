import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { createFincodePeriodId } from "../fincode/subscriptionPeriodSource";
import { ServerFoundationError } from "../http/errors";
import { createDeepQuotaRef, PREMIUM_DEEP_MONTHLY_LIMIT } from "../readingPersistence/deepQuota";
import { createLightQuotaRef, getLightQuotaLimit } from "../readingPersistence/lightQuota";
import type { FincodeMembershipRecordV1 } from "../fincode/membershipSchema";
import type { MembershipQuotaRepository, PublicQuotaBalances } from "./membershipQuotaRepository";

type Sender = { send(command: GetItemCommand): Promise<{ Item?: Record<string, AttributeValue> }> };

function integer(item: Record<string, AttributeValue> | undefined, name: string): number | null {
  const value = item?.[name];
  if (!value || !("N" in value) || !/^\d+$/u.test(value.N ?? "")) return null;
  const parsed = Number(value.N);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function activeReservations(item: Record<string, AttributeValue> | undefined, nowEpochSeconds: number): number {
  const list = item?.reservations;
  if (!list || !("L" in list) || !Array.isArray(list.L)) return 0;
  let active = 0;
  for (const entry of list.L) {
    if (!("M" in entry) || !entry.M) throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
    const expiresAt = integer(entry.M, "expires_at");
    if (expiresAt === null) throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
    if (expiresAt > nowEpochSeconds) active += 1;
  }
  return active;
}

function required(value: string | undefined, code: string): string {
  if (!value || value.length > 255 || /[\r\n\0]/u.test(value)) throw new ServerFoundationError(code);
  return value;
}

export class DynamoMembershipQuotaRepository implements MembershipQuotaRepository {
  constructor(
    private readonly sender: Sender,
    private readonly lightTableName: string,
    private readonly deepTableName: string,
    private readonly deepHashSecret: string,
  ) {}

  async readBalances(input: { userId: string; membership: FincodeMembershipRecordV1; now: Date }): Promise<PublicQuotaBalances> {
    if (!input.userId || !Number.isFinite(input.now.getTime())) throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
    if (input.membership.plan === "free" || input.membership.subscriptionStatus !== "active") {
      return { light_monthly_limit: 0, light_monthly_used: 0, light_monthly_remaining: 0, deep_monthly_limit: 0, deep_monthly_used: 0, deep_monthly_remaining: 0 };
    }
    const start = input.membership.currentPeriodStart;
    const end = input.membership.currentPeriodEnd;
    if (!start || !end || input.now.getTime() < Date.parse(start) || input.now.getTime() >= Date.parse(end)) {
      throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
    }
    const periodId = createFincodePeriodId(start, end);
    const lightLimit = getLightQuotaLimit(input.membership.plan);
    const lightRef = createLightQuotaRef({ userId: input.userId, periodId });
    try {
      const light = await this.sender.send(new GetItemCommand({
        TableName: this.lightTableName,
        Key: { quota_ref: { S: lightRef } },
        ProjectionExpression: "#limit, used, reservations, period_id, membership_version",
        ExpressionAttributeNames: { "#limit": "limit" },
        ConsistentRead: true,
      }));
      const storedLightLimit = integer(light.Item, "limit");
      const lightUsed = integer(light.Item, "used");
      const membershipVersion = integer(light.Item, "membership_version");
      const storedPeriod = light.Item?.period_id && "S" in light.Item.period_id ? light.Item.period_id.S : undefined;
      if (!light.Item || storedLightLimit !== lightLimit || lightUsed === null || lightUsed > lightLimit ||
          membershipVersion !== input.membership.membershipVersion || storedPeriod !== periodId) {
        throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
      }
      const nowEpoch = Math.floor(input.now.getTime() / 1000);
      const lightReserved = activeReservations(light.Item, nowEpoch);
      const lightRemaining = Math.max(lightLimit - lightUsed - lightReserved, 0);

      let deepUsed = 0;
      let deepRemaining = 0;
      const deepLimit = input.membership.plan === "premium" && input.membership.deepEnabled ? PREMIUM_DEEP_MONTHLY_LIMIT : 0;
      if (deepLimit > 0) {
        const deepRef = createDeepQuotaRef({ userId: input.userId, periodKey: periodId, secret: this.deepHashSecret });
        const deep = await this.sender.send(new GetItemCommand({
          TableName: this.deepTableName,
          Key: { quota_ref: { S: deepRef } },
          ProjectionExpression: "used, reservations, period_key",
          ConsistentRead: true,
        }));
        if (deep.Item) {
          deepUsed = integer(deep.Item, "used") ?? -1;
          const storedDeepPeriod = deep.Item.period_key && "S" in deep.Item.period_key ? deep.Item.period_key.S : undefined;
          if (deepUsed < 0 || deepUsed > deepLimit || storedDeepPeriod !== periodId) throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
          deepRemaining = Math.max(deepLimit - deepUsed - activeReservations(deep.Item, nowEpoch), 0);
        } else {
          deepRemaining = deepLimit;
        }
      }
      return {
        light_monthly_limit: lightLimit,
        light_monthly_used: lightUsed,
        light_monthly_remaining: lightRemaining,
        deep_monthly_limit: deepLimit,
        deep_monthly_used: deepUsed,
        deep_monthly_remaining: deepRemaining,
      };
    } catch (error) {
      if (error instanceof ServerFoundationError) throw error;
      throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE", { cause: error });
    }
  }
}

export function createDynamoMembershipQuotaRepository(env: NodeJS.ProcessEnv = process.env): MembershipQuotaRepository {
  const lightTable = required(env.FINCODE_MEMBERSHIP_QUOTA_TABLE, "MEMBERSHIP_QUOTA_UNAVAILABLE");
  const deepTable = required(env.READING_DEEP_QUOTA_TABLE_NAME, "MEMBERSHIP_QUOTA_UNAVAILABLE");
  const secret = env.READING_DEEP_QUOTA_HASH_SECRET ?? "";
  if (secret.length < 32 || secret.length > 4096 || /[\r\n\0]/u.test(secret)) throw new ServerFoundationError("MEMBERSHIP_QUOTA_UNAVAILABLE");
  return new DynamoMembershipQuotaRepository(new DynamoDBClient({}), lightTable, deepTable, secret);
}
