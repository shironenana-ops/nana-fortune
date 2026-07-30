import { createHash } from "node:crypto";
import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";

export const LIGHT_QUOTA_SCHEMA_VERSION = "fincode-membership-quota-v1";
export const LIGHT_PLAN_MONTHLY_LIMIT = 5;
export const PREMIUM_LIGHT_MONTHLY_LIMIT = 20;
const DIGEST = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export type LightQuotaPlan = "light" | "premium";
export type LightQuotaReservation = {
  requestRef: string;
  historyId: string;
  reservationId: string;
  reservedAt: string;
  expiresAt: number;
};
export type LightQuotaRecord = {
  quotaRef: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  plan: LightQuotaPlan;
  limit: 5 | 20;
  used: number;
  reservations: LightQuotaReservation[];
  completedRequestRefs: string[];
  version: number;
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
};

export type LightQuotaMembershipSnapshot = {
  plan: LightQuotaPlan;
  subscriptionStatus: "active";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  version: number;
};

export interface LightQuotaRepositoryPort {
  read(quotaRef: string): Promise<LightQuotaRecord | null>;
  apply(action: TransactWriteItem): Promise<"APPLIED" | "CONFLICT" | "UNAVAILABLE">;
}

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });

export function getLightQuotaLimit(plan: "free" | LightQuotaPlan): 0 | 5 | 20 {
  return plan === "light" ? LIGHT_PLAN_MONTHLY_LIMIT : plan === "premium" ? PREMIUM_LIGHT_MONTHLY_LIMIT : 0;
}

export function createLightQuotaRef(input: { userId: string; periodId: string }): string {
  if (!input.userId || input.userId.length > 128 || /[\r\n\0]/u.test(input.userId) || !DIGEST.test(input.periodId)) {
    throw new ServerFoundationError("READING_LIGHT_QUOTA_INCONSISTENT");
  }
  return createHash("sha256").update(`shirone-light-quota-v1\0${input.userId}\0${input.periodId}`, "utf8").digest("hex");
}

export function validateLightQuotaRecord(value: unknown): value is LightQuotaRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LightQuotaRecord>;
  if (!DIGEST.test(item.quotaRef ?? "") || !DIGEST.test(item.periodId ?? "") || !["light", "premium"].includes(item.plan ?? "") ||
      item.limit !== getLightQuotaLimit(item.plan as LightQuotaPlan) || !Number.isSafeInteger(item.used) || (item.used ?? -1) < 0 ||
      !Number.isSafeInteger(item.version) || (item.version ?? 0) < 1 || !Number.isSafeInteger(item.membershipVersion) || (item.membershipVersion ?? -1) < 0 ||
      !Array.isArray(item.reservations) || !Array.isArray(item.completedRequestRefs) || !ISO.test(item.periodStart ?? "") || !ISO.test(item.periodEnd ?? "") ||
      !Number.isFinite(Date.parse(item.periodStart ?? "")) || !Number.isFinite(Date.parse(item.periodEnd ?? "")) ||
      Date.parse(item.periodStart ?? "") >= Date.parse(item.periodEnd ?? "") || !Number.isSafeInteger(item.expiresAt) || (item.expiresAt ?? 0) <= 0) return false;
  if (item.used! > item.limit! || item.reservations!.length + item.used! > item.limit! ||
      item.completedRequestRefs!.length > item.used! || new Set(item.completedRequestRefs).size !== item.completedRequestRefs.length ||
      new Set(item.reservations!.map((entry) => entry.requestRef)).size !== item.reservations!.length ||
      new Set(item.reservations!.map((entry) => entry.reservationId)).size !== item.reservations!.length) return false;
  return item.reservations!.every((reservation) => DIGEST.test(reservation.requestRef) && !!reservation.historyId && !!reservation.reservationId &&
    ISO.test(reservation.reservedAt) && Number.isSafeInteger(reservation.expiresAt) && reservation.expiresAt > 0) &&
    item.completedRequestRefs!.every((requestRef) => DIGEST.test(requestRef));
}

function reservationAttribute(value: LightQuotaReservation): AttributeValue {
  return { M: {
    request_ref: S(value.requestRef), history_id: S(value.historyId), reservation_id: S(value.reservationId),
    reserved_at: S(value.reservedAt), expires_at: N(value.expiresAt),
  } };
}

export function buildLightQuotaWriteAction(tableName: string, previous: LightQuotaRecord, next: LightQuotaRecord): TransactWriteItem {
  if (!tableName || !validateLightQuotaRecord(previous) || !validateLightQuotaRecord(next) || previous.quotaRef !== next.quotaRef ||
      previous.periodId !== next.periodId || previous.membershipVersion !== next.membershipVersion || next.version !== previous.version + 1) {
    throw new ServerFoundationError("READING_LIGHT_QUOTA_INCONSISTENT");
  }
  return { Put: {
    TableName: tableName,
    Item: {
      quota_ref: S(next.quotaRef), schema_version: S(LIGHT_QUOTA_SCHEMA_VERSION), period_id: S(next.periodId),
      period_start: S(next.periodStart), period_end: S(next.periodEnd), plan: S(next.plan), limit: N(next.limit), used: N(next.used),
      reservations: { L: next.reservations.map(reservationAttribute) },
      ...(next.completedRequestRefs.length ? { completed_request_refs: { SS: next.completedRequestRefs } as AttributeValue } : {}),
      version: N(next.version), membership_version: N(next.membershipVersion), created_at: S(next.createdAt), updated_at: S(next.updatedAt), expires_at: N(next.expiresAt),
    },
    ConditionExpression: "#version = :expectedVersion AND membership_version = :membershipVersion AND period_id = :periodId",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":expectedVersion": N(previous.version), ":membershipVersion": N(previous.membershipVersion), ":periodId": S(previous.periodId) },
  } };
}

export type LightQuotaLifecycleResult =
  | { status: "RESERVED"; reservation: LightQuotaReservation; next: LightQuotaRecord; action: TransactWriteItem }
  | { status: "COMPLETED" | "RELEASED"; next: LightQuotaRecord; action: TransactWriteItem }
  | { status: "DUPLICATE_RESERVED" | "DUPLICATE_COMPLETED" | "ALREADY_RELEASED" }
  | { status: "LIMIT_REACHED" };

type CommonInput = {
  tableName: string;
  item: LightQuotaRecord | null;
  userId: string;
  periodId: string;
  membership: LightQuotaMembershipSnapshot;
  mode: "free" | "light" | "deep";
  requestRef: string;
  now: Date;
};

function checked(input: CommonInput): LightQuotaRecord {
  if (input.mode !== "light") throw new ServerFoundationError("READING_LIGHT_QUOTA_NOT_APPLICABLE");
  if (!input.item || !validateLightQuotaRecord(input.item) || !DIGEST.test(input.requestRef) || !input.membership ||
      input.item.quotaRef !== createLightQuotaRef({ userId: input.userId, periodId: input.periodId }) ||
      input.item.periodId !== input.periodId || input.item.membershipVersion !== input.membership.version ||
      input.item.plan !== input.membership.plan || input.membership.subscriptionStatus !== "active" ||
      input.item.periodStart !== input.membership.currentPeriodStart || input.item.periodEnd !== input.membership.currentPeriodEnd ||
      !Number.isFinite(input.now.getTime()) || input.now.getTime() < Date.parse(input.item.periodStart) || input.now.getTime() >= Date.parse(input.item.periodEnd)) {
    throw new ServerFoundationError("READING_LIGHT_QUOTA_INCONSISTENT");
  }
  return input.item;
}

export function reserveLightQuota(input: CommonInput & { historyId: string; reservationId: string; reservationSeconds: number }): LightQuotaLifecycleResult {
  const item = checked(input);
  if (item.completedRequestRefs.includes(input.requestRef)) return { status: "DUPLICATE_COMPLETED" };
  const existing = item.reservations.find((reservation) => reservation.requestRef === input.requestRef);
  if (existing) return { status: "DUPLICATE_RESERVED" };
  if (!input.historyId || !input.reservationId || !Number.isSafeInteger(input.reservationSeconds) || input.reservationSeconds < 120 || input.reservationSeconds > 1800) {
    throw new ServerFoundationError("READING_LIGHT_QUOTA_INCONSISTENT");
  }
  const nowEpoch = Math.floor(input.now.getTime() / 1000);
  const active = item.reservations.filter((reservation) => reservation.expiresAt > nowEpoch);
  if (item.used + active.length >= item.limit) return { status: "LIMIT_REACHED" };
  const reservation = { requestRef: input.requestRef, historyId: input.historyId, reservationId: input.reservationId,
    reservedAt: input.now.toISOString(), expiresAt: nowEpoch + input.reservationSeconds };
  const next = { ...item, reservations: [...active, reservation], version: item.version + 1, updatedAt: input.now.toISOString() };
  return { status: "RESERVED", reservation, next, action: buildLightQuotaWriteAction(input.tableName, item, next) };
}

export function completeLightQuota(input: CommonInput & { reservationId: string }): LightQuotaLifecycleResult {
  const item = checked(input);
  if (item.completedRequestRefs.includes(input.requestRef)) return { status: "DUPLICATE_COMPLETED" };
  const reservation = item.reservations.find((entry) => entry.requestRef === input.requestRef && entry.reservationId === input.reservationId);
  if (!reservation || item.used >= item.limit) throw new ServerFoundationError("READING_LIGHT_QUOTA_INCONSISTENT");
  const next = { ...item, used: item.used + 1, reservations: item.reservations.filter((entry) => entry !== reservation),
    completedRequestRefs: [...item.completedRequestRefs, input.requestRef], version: item.version + 1, updatedAt: input.now.toISOString() };
  return { status: "COMPLETED", next, action: buildLightQuotaWriteAction(input.tableName, item, next) };
}

export function releaseLightQuota(input: CommonInput & { reservationId: string }): LightQuotaLifecycleResult {
  const item = checked(input);
  if (item.completedRequestRefs.includes(input.requestRef)) return { status: "DUPLICATE_COMPLETED" };
  const reservation = item.reservations.find((entry) => entry.requestRef === input.requestRef && entry.reservationId === input.reservationId);
  if (!reservation) return { status: "ALREADY_RELEASED" };
  const next = { ...item, reservations: item.reservations.filter((entry) => entry !== reservation), version: item.version + 1, updatedAt: input.now.toISOString() };
  return { status: "RELEASED", next, action: buildLightQuotaWriteAction(input.tableName, item, next) };
}
