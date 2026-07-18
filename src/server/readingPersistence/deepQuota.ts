import { createHmac } from "node:crypto";
import { ServerFoundationError } from "../http/errors";

export const PREMIUM_DEEP_MONTHLY_LIMIT = 3;
export const DEEP_QUOTA_SCHEMA_VERSION = "shirone-deep-quota-v1";
const QUOTA_REF_DOMAIN = `${DEEP_QUOTA_SCHEMA_VERSION}\0`;

export type DeepQuotaConfig = {
  tableName: string;
  usersTableName: string;
  hashSecret: string;
  reservationSeconds: number;
};

function strictInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  }
  return parsed;
}

function strictSecret(value: string | undefined): string {
  if (!value || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  }
  return value;
}

function strictName(value: string | undefined): string {
  if (!value || value.trim() !== value || value.length > 255 || /[\r\n\0]/u.test(value)) {
    throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  }
  return value;
}

export function readDeepQuotaConfig(env: Record<string, string | undefined> = process.env): DeepQuotaConfig {
  return {
    tableName: strictName(env.READING_DEEP_QUOTA_TABLE_NAME),
    usersTableName: strictName(env.USERS_TABLE_NAME),
    hashSecret: strictSecret(env.READING_DEEP_QUOTA_HASH_SECRET),
    reservationSeconds: strictInteger(env.READING_DEEP_RESERVATION_SECONDS, 600, 120, 1800),
  };
}

export function getJstPeriodKey(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  return `${year}-${month}`;
}

export function createDeepQuotaRef(params: { userId: string; periodKey: string; secret?: string }): string {
  const secret = strictSecret(params.secret);
  if (!params.userId || !/^\d{4}-\d{2}$/u.test(params.periodKey)) {
    throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
  }
  return createHmac("sha256", secret)
    .update(`${QUOTA_REF_DOMAIN}${params.userId}\0${params.periodKey}`, "utf8")
    .digest("hex");
}

export function calculateDeepRemaining(params: { limit?: number; used: number; activeReservations: number }): number {
  const limit = params.limit ?? PREMIUM_DEEP_MONTHLY_LIMIT;
  return Math.max(limit - params.used - params.activeReservations, 0);
}
