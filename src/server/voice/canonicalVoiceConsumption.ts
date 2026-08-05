import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb";

export type CanonicalVoiceBalance = {
  plan: "free" | "light" | "premium";
  subscriptionStatus: "active" | "inactive";
  monthlyVoiceLimit: number;
  monthlyVoiceUsed: number;
  extraVoiceRemaining: number;
};
export type CanonicalVoiceDecision = "MONTHLY" | "EXTRA" | "LIMIT_REACHED";

export function decideCanonicalVoiceConsumption(balance: CanonicalVoiceBalance): CanonicalVoiceDecision {
  if (![balance.monthlyVoiceLimit, balance.monthlyVoiceUsed, balance.extraVoiceRemaining]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return "LIMIT_REACHED";
  const monthlyEligible = balance.subscriptionStatus === "active" &&
    ((balance.plan === "light" && balance.monthlyVoiceLimit === 3) ||
     (balance.plan === "premium" && balance.monthlyVoiceLimit === 10));
  if (monthlyEligible && balance.monthlyVoiceUsed < balance.monthlyVoiceLimit) return "MONTHLY";
  return balance.extraVoiceRemaining > 0 ? "EXTRA" : "LIMIT_REACHED";
}

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });

export function buildCanonicalVoiceCompletionTransaction(input: {
  usersTableName: string;
  historyTableName: string;
  userId: string;
  historyId: string;
  eventRef: string;
  resultLocation: string;
  completedAt: string;
  balance: CanonicalVoiceBalance;
}): TransactWriteItem[] {
  const decision = decideCanonicalVoiceConsumption(input.balance);
  if (decision === "LIMIT_REACHED" || !input.usersTableName || !input.historyTableName || !input.userId || !input.historyId ||
      !/^[0-9a-f]{64}$/u.test(input.eventRef) || !input.resultLocation || !Number.isFinite(Date.parse(input.completedAt))) {
    throw new Error("CANONICAL_VOICE_COMPLETION_INVALID");
  }
  const monthly = decision === "MONTHLY";
  return [
    { Update: {
      TableName: input.usersTableName,
      Key: { user_id: s(input.userId) },
      UpdateExpression: monthly ? "SET monthly_voice_used = monthly_voice_used + :one, updated_at=:now" : "SET extra_voice_remaining = extra_voice_remaining - :one, updated_at=:now",
      ConditionExpression: monthly
        ? "attribute_exists(user_id) AND subscription_status=:active AND (#plan=:light OR #plan=:premium) AND monthly_voice_limit=:limit AND monthly_voice_used=:used AND monthly_voice_used < monthly_voice_limit"
        : "attribute_exists(user_id) AND extra_voice_remaining=:extra AND extra_voice_remaining > :zero",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: {
        ":one": n(1), ":now": s(input.completedAt), ":zero": n(0),
        ...(monthly ? { ":active": s("active"), ":light": s("light"), ":premium": s("premium"), ":limit": n(input.balance.monthlyVoiceLimit), ":used": n(input.balance.monthlyVoiceUsed) }
          : { ":extra": n(input.balance.extraVoiceRemaining) }),
      },
    } },
    { Update: {
      TableName: input.historyTableName,
      Key: { user_id: s(input.userId), history_id: s(input.historyId) },
      UpdateExpression: "SET #status=:completed, result_location=:result, voice_consumption=:consumption, voice_event_ref=:event, updated_at=:now",
      ConditionExpression: "#status=:processing AND attribute_not_exists(voice_event_ref)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":completed": s("completed"), ":processing": s("processing"), ":result": s(input.resultLocation),
        ":consumption": s(monthly ? "monthly" : "extra"), ":event": s(input.eventRef), ":now": s(input.completedAt) },
    } },
  ];
}
