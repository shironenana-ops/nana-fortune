import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb";

export type CanonicalVoiceBalance = {
  plan: "free" | "light" | "premium";
  subscriptionStatus: "active" | "inactive";
  monthlyVoiceLimit: number;
  monthlyVoiceUsed: number;
  extraVoiceRemaining: number;
  monthlyVoiceReserved?: number;
  extraVoiceReserved?: number;
};
export type CanonicalVoiceDecision = "MONTHLY" | "EXTRA" | "LIMIT_REACHED";

export function decideCanonicalVoiceConsumption(balance: CanonicalVoiceBalance): CanonicalVoiceDecision {
  const monthlyReserved = balance.monthlyVoiceReserved ?? 0;
  const extraReserved = balance.extraVoiceReserved ?? 0;
  if (![balance.monthlyVoiceLimit, balance.monthlyVoiceUsed, balance.extraVoiceRemaining, monthlyReserved, extraReserved]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return "LIMIT_REACHED";
  const monthlyEligible = balance.subscriptionStatus === "active" &&
    ((balance.plan === "light" && balance.monthlyVoiceLimit === 3) ||
     (balance.plan === "premium" && balance.monthlyVoiceLimit === 10));
  if (monthlyEligible && balance.monthlyVoiceUsed + monthlyReserved < balance.monthlyVoiceLimit) return "MONTHLY";
  return balance.extraVoiceRemaining > extraReserved ? "EXTRA" : "LIMIT_REACHED";
}

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });

function validRef(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function buildCanonicalVoiceReservationTransaction(input: {
  usersTableName: string;
  historyTableName: string;
  userId: string;
  historyId: string;
  reservationRef: string;
  createdAt: string;
  membershipVersion: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  balance: CanonicalVoiceBalance;
}): TransactWriteItem[] {
  const decision = decideCanonicalVoiceConsumption(input.balance);
  const monthlyReserved = input.balance.monthlyVoiceReserved ?? 0;
  const extraReserved = input.balance.extraVoiceReserved ?? 0;
  if (decision === "LIMIT_REACHED" || !input.usersTableName || !input.historyTableName || !input.userId || !input.historyId ||
      !validRef(input.reservationRef) || !validTimestamp(input.createdAt) || !Number.isSafeInteger(input.membershipVersion) || input.membershipVersion < 1) {
    throw new Error("CANONICAL_VOICE_RESERVATION_INVALID");
  }
  const monthly = decision === "MONTHLY";
  if (monthly && (!input.currentPeriodStart || !input.currentPeriodEnd || !validTimestamp(input.currentPeriodStart) ||
      !validTimestamp(input.currentPeriodEnd) || Date.parse(input.currentPeriodStart) >= Date.parse(input.currentPeriodEnd))) {
    throw new Error("CANONICAL_VOICE_RESERVATION_INVALID");
  }
  return [
    { Update: {
      TableName: input.usersTableName,
      Key: { user_id: s(input.userId) },
      UpdateExpression: monthly
        ? "SET monthly_voice_reserved = if_not_exists(monthly_voice_reserved, :zero) + :one, updated_at=:now"
        : "SET extra_voice_reserved = if_not_exists(extra_voice_reserved, :zero) + :one, updated_at=:now",
      ConditionExpression: monthly
        ? "attribute_exists(user_id) AND membership_schema_version=:schema AND membership_version=:version AND subscription_status=:active AND (#plan=:light OR #plan=:premium) AND current_period_start=:period_start AND current_period_end=:period_end AND monthly_voice_limit=:limit AND monthly_voice_used=:used AND (attribute_not_exists(monthly_voice_reserved) OR monthly_voice_reserved=:reserved) AND :used_plus_reserved < :limit"
        : "attribute_exists(user_id) AND membership_schema_version=:schema AND membership_version=:version AND extra_voice_remaining=:extra AND (attribute_not_exists(extra_voice_reserved) OR extra_voice_reserved=:reserved) AND :extra > :reserved",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: {
        ":zero": n(0), ":one": n(1), ":now": s(input.createdAt), ":schema": s("shirone-membership-v1"), ":version": n(input.membershipVersion),
        ":reserved": n(monthly ? monthlyReserved : extraReserved),
        ...(monthly ? {
          ":active": s("active"), ":light": s("light"), ":premium": s("premium"),
          ":period_start": s(input.currentPeriodStart!), ":period_end": s(input.currentPeriodEnd!),
          ":limit": n(input.balance.monthlyVoiceLimit), ":used": n(input.balance.monthlyVoiceUsed),
          ":used_plus_reserved": n(input.balance.monthlyVoiceUsed + monthlyReserved),
        } : { ":extra": n(input.balance.extraVoiceRemaining) }),
      },
    } },
    { Put: {
      TableName: input.historyTableName,
      Item: {
        user_id: s(input.userId), history_id: s(input.historyId), type: s("voice"), status: s("processing"),
        voice_reservation_ref: s(input.reservationRef), voice_consumption: s(monthly ? "monthly" : "extra"),
        created_at: s(input.createdAt), updated_at: s(input.createdAt),
      },
      ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(history_id)",
    } },
  ];
}

export function buildCanonicalVoiceReservedCompletionTransaction(input: {
  usersTableName: string;
  historyTableName: string;
  userId: string;
  historyId: string;
  reservationRef: string;
  completionRef: string;
  resultLocation: string;
  completedAt: string;
  consumption: "monthly" | "extra";
}): TransactWriteItem[] {
  if (!input.usersTableName || !input.historyTableName || !input.userId || !input.historyId || !validRef(input.reservationRef) ||
      !validRef(input.completionRef) || !input.resultLocation || !validTimestamp(input.completedAt)) {
    throw new Error("CANONICAL_VOICE_COMPLETION_INVALID");
  }
  const monthly = input.consumption === "monthly";
  return [
    { Update: {
      TableName: input.usersTableName,
      Key: { user_id: s(input.userId) },
      UpdateExpression: monthly
        ? "SET monthly_voice_reserved = monthly_voice_reserved - :one, monthly_voice_used = monthly_voice_used + :one, updated_at=:now"
        : "SET extra_voice_reserved = extra_voice_reserved - :one, extra_voice_remaining = extra_voice_remaining - :one, updated_at=:now",
      ConditionExpression: monthly
        ? "attribute_exists(user_id) AND monthly_voice_reserved >= :one AND monthly_voice_used < monthly_voice_limit"
        : "attribute_exists(user_id) AND extra_voice_reserved >= :one AND extra_voice_remaining >= :one",
      ExpressionAttributeValues: { ":one": n(1), ":now": s(input.completedAt) },
    } },
    { Update: {
      TableName: input.historyTableName,
      Key: { user_id: s(input.userId), history_id: s(input.historyId) },
      UpdateExpression: "SET #status=:completed, result_location=:result, voice_completion_ref=:completion, updated_at=:now",
      ConditionExpression: "#status=:processing AND voice_reservation_ref=:reservation AND voice_consumption=:consumption AND attribute_not_exists(voice_completion_ref)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":completed": s("completed"), ":processing": s("processing"), ":result": s(input.resultLocation),
        ":completion": s(input.completionRef), ":reservation": s(input.reservationRef),
        ":consumption": s(input.consumption), ":now": s(input.completedAt),
      },
    } },
  ];
}

export function buildCanonicalVoiceReleaseTransaction(input: {
  usersTableName: string;
  historyTableName: string;
  userId: string;
  historyId: string;
  reservationRef: string;
  releasedAt: string;
  consumption: "monthly" | "extra";
  failureCode: string;
}): TransactWriteItem[] {
  if (!input.usersTableName || !input.historyTableName || !input.userId || !input.historyId || !validRef(input.reservationRef) ||
      !validTimestamp(input.releasedAt) || !/^[A-Z0-9_]{3,64}$/u.test(input.failureCode)) {
    throw new Error("CANONICAL_VOICE_RELEASE_INVALID");
  }
  const reservationField = input.consumption === "monthly" ? "monthly_voice_reserved" : "extra_voice_reserved";
  return [
    { Update: {
      TableName: input.usersTableName,
      Key: { user_id: s(input.userId) },
      UpdateExpression: `SET ${reservationField} = ${reservationField} - :one, updated_at=:now`,
      ConditionExpression: `attribute_exists(user_id) AND ${reservationField} >= :one`,
      ExpressionAttributeValues: { ":one": n(1), ":now": s(input.releasedAt) },
    } },
    { Update: {
      TableName: input.historyTableName,
      Key: { user_id: s(input.userId), history_id: s(input.historyId) },
      UpdateExpression: "SET #status=:failed, safe_failure_code=:failure, updated_at=:now",
      ConditionExpression: "#status=:processing AND voice_reservation_ref=:reservation AND voice_consumption=:consumption AND attribute_not_exists(voice_completion_ref)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":failed": s("failed"), ":processing": s("processing"), ":failure": s(input.failureCode),
        ":reservation": s(input.reservationRef), ":consumption": s(input.consumption), ":now": s(input.releasedAt),
      },
    } },
  ];
}

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
