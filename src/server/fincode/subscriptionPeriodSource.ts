import { createHash } from "node:crypto";
import type { FincodeEnvironment, FincodeSubscriptionEventType } from "./webhookTypes";
import type { FincodeMembershipPlan } from "./membershipSchema";

export const FINCODE_PERIOD_SOURCE_RESULTS = ["RESOLVED", "NOT_AVAILABLE", "CONFLICT", "UNAVAILABLE"] as const;
export type FincodeSubscriptionPeriodInput = {
  environment: FincodeEnvironment;
  subscriptionReference: string;
  subscriptionDigest: string;
  customerReference: string;
  customerDigest: string;
  planReference: string;
  plan: Exclude<FincodeMembershipPlan, "free">;
  eventType: FincodeSubscriptionEventType;
  processDate: string;
};
export type FincodeResolvedSubscriptionPeriod = {
  status: "RESOLVED";
  periodId: string;
  periodStart: string;
  periodEnd: string;
  source: "TRUSTED_MEMBERSHIP_SOURCE" | "PROVISIONAL_FINCODE_TEST_ASIA_TOKYO";
  sourceVersion: string;
};
export type FincodeSubscriptionPeriodResult = FincodeResolvedSubscriptionPeriod |
  { status: "NOT_AVAILABLE" } | { status: "CONFLICT" } | { status: "UNAVAILABLE" };
export interface FincodeSubscriptionPeriodSource {
  resolve(input: FincodeSubscriptionPeriodInput): Promise<FincodeSubscriptionPeriodResult>;
}

export class StaticFincodeSubscriptionPeriodSource implements FincodeSubscriptionPeriodSource {
  constructor(private readonly results: ReadonlyMap<string, FincodeSubscriptionPeriodResult>) {}

  async resolve(input: FincodeSubscriptionPeriodInput): Promise<FincodeSubscriptionPeriodResult> {
    if (!validateFincodeSubscriptionPeriodInput(input)) return { status: "CONFLICT" };
    const value = this.results.get(input.subscriptionDigest) ?? { status: "NOT_AVAILABLE" as const };
    return validateFincodeSubscriptionPeriodResult(value) ?? { status: "CONFLICT" };
  }
}

const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION = /^[A-Za-z0-9_.-]{1,64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function createFincodePeriodId(periodStart: string, periodEnd: string): string {
  if (!ISO.test(periodStart) || !ISO.test(periodEnd) || !Number.isFinite(Date.parse(periodStart)) ||
      !Number.isFinite(Date.parse(periodEnd)) || Date.parse(periodStart) >= Date.parse(periodEnd) ||
      new Date(periodStart).toISOString() !== periodStart || new Date(periodEnd).toISOString() !== periodEnd) {
    throw new Error("FINCODE_PERIOD_INVALID");
  }
  return createHash("sha256").update(`fincode-contract-period-v1\0${periodStart}\0${periodEnd}`, "utf8").digest("hex");
}

export function validateFincodeSubscriptionPeriodResult(value: unknown): FincodeSubscriptionPeriodResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.status === "NOT_AVAILABLE" || input.status === "CONFLICT" || input.status === "UNAVAILABLE") {
    return Object.keys(input).length === 1 ? { status: input.status } : null;
  }
  if (input.status !== "RESOLVED" || Object.keys(input).sort().join(",") !== "periodEnd,periodId,periodStart,source,sourceVersion,status") return null;
  if (typeof input.periodStart !== "string" || typeof input.periodEnd !== "string" || typeof input.periodId !== "string" ||
      !["TRUSTED_MEMBERSHIP_SOURCE", "PROVISIONAL_FINCODE_TEST_ASIA_TOKYO"].includes(String(input.source)) || typeof input.sourceVersion !== "string" || !VERSION.test(input.sourceVersion)) return null;
  try {
    if (!DIGEST.test(input.periodId) || createFincodePeriodId(input.periodStart, input.periodEnd) !== input.periodId) return null;
  } catch { return null; }
  return input as FincodeResolvedSubscriptionPeriod;
}

export function validateFincodeSubscriptionPeriodInput(value: unknown): value is FincodeSubscriptionPeriodInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).sort().join(",") === "customerDigest,customerReference,environment,eventType,plan,planReference,processDate,subscriptionDigest,subscriptionReference" &&
    ["staging", "production"].includes(String(input.environment)) && DIGEST.test(String(input.subscriptionDigest)) &&
    DIGEST.test(String(input.customerDigest)) && ["light", "premium"].includes(String(input.plan)) &&
    typeof input.subscriptionReference === "string" && /^[A-Za-z0-9_-]{1,25}$/u.test(input.subscriptionReference) &&
    typeof input.customerReference === "string" && /^[A-Za-z0-9_-]{1,60}$/u.test(input.customerReference) &&
    typeof input.planReference === "string" && /^[A-Za-z0-9_-]{1,25}$/u.test(input.planReference) &&
    ["subscription.card.regist", "subscription.card.update", "subscription.card.delete"].includes(String(input.eventType)) &&
    typeof input.processDate === "string";
}
