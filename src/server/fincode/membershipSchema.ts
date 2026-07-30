export const FINCODE_MEMBERSHIP_SCHEMA_VERSION = "shirone-membership-v1";

export type FincodeMembershipPlan = "free" | "light" | "premium";
export type FincodeMembershipStatus = "active" | "inactive";
export type FincodeMembershipSource = "fincode_direct" | "manual" | "legacy_migration";

export type FincodeMembershipRecordV1 = {
  schemaVersion: typeof FINCODE_MEMBERSHIP_SCHEMA_VERSION;
  plan: FincodeMembershipPlan;
  subscriptionStatus: FincodeMembershipStatus;
  deepEnabled: boolean;
  monthlyVoiceLimit: number;
  monthlyVoiceUsed: number;
  extraVoiceRemaining: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  membershipVersion: number;
  membershipSource: FincodeMembershipSource;
  membershipUpdatedAt: string;
};

const SOURCES = new Set<FincodeMembershipSource>(["fincode_direct", "manual", "legacy_migration"]);

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function parseFincodeMembershipRecordV1(value: unknown): FincodeMembershipRecordV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const plan = input.plan;
  const status = input.subscription_status;
  const start = timestamp(input.current_period_start);
  const end = timestamp(input.current_period_end);
  const version = integer(input.membership_version);
  const voiceLimit = integer(input.monthly_voice_limit);
  const voiceUsed = integer(input.monthly_voice_used);
  const extraVoice = integer(input.extra_voice_remaining);
  const source = input.membership_source;
  const updatedAt = timestamp(input.membership_updated_at);
  if (input.membership_schema_version !== FINCODE_MEMBERSHIP_SCHEMA_VERSION ||
      !["free", "light", "premium"].includes(String(plan)) || !["active", "inactive"].includes(String(status)) ||
      typeof input.deep_enabled !== "boolean" || typeof input.cancel_at_period_end !== "boolean" ||
      version === null || voiceLimit === null || voiceUsed === null || extraVoice === null ||
      start === undefined || end === undefined || updatedAt === undefined || updatedAt === null ||
      !SOURCES.has(source as FincodeMembershipSource) || (start === null) !== (end === null) ||
      (start !== null && end !== null && Date.parse(start) >= Date.parse(end))) return null;
  const policy =
    (plan === "free" && status === "inactive" && input.deep_enabled === false && voiceLimit === 0) ||
    (plan === "light" && status === "active" && input.deep_enabled === false && voiceLimit === 3) ||
    (plan === "premium" && status === "active" && input.deep_enabled === true && voiceLimit === 10);
  if (!policy || ((plan === "light" || plan === "premium") && start === null)) return null;
  return {
    schemaVersion: FINCODE_MEMBERSHIP_SCHEMA_VERSION,
    plan: plan as FincodeMembershipPlan,
    subscriptionStatus: status as FincodeMembershipStatus,
    deepEnabled: input.deep_enabled,
    monthlyVoiceLimit: voiceLimit,
    monthlyVoiceUsed: voiceUsed,
    extraVoiceRemaining: extraVoice,
    cancelAtPeriodEnd: input.cancel_at_period_end,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    membershipVersion: version,
    membershipSource: source as FincodeMembershipSource,
    membershipUpdatedAt: updatedAt,
  };
}

export type FincodeMembershipTransitionDecision =
  | "ACTIVATE"
  | "SAME_PERIOD_UPDATE"
  | "NEW_PERIOD_RENEWAL"
  | "INCOMPLETE_NEW"
  | "INCOMPLETE_EXISTING"
  | "CANCEL_SCHEDULED"
  | "CANCEL_EFFECTIVE_REQUIRES_SEPARATE_PROCESS"
  | "PLAN_CHANGE_MANUAL_REVIEW"
  | "REJECT";

export function decideFincodeMembershipTransition(input: {
  current: FincodeMembershipRecordV1 | null;
  targetPlan: FincodeMembershipPlan | null;
  providerStatus: "ACTIVE" | "RUNNING" | "CANCELED" | "INCOMPLETE" | string;
  period?: { periodStart: string; periodEnd: string };
}): FincodeMembershipTransitionDecision {
  if (!input.targetPlan || !["ACTIVE", "RUNNING", "CANCELED", "INCOMPLETE"].includes(input.providerStatus)) return "REJECT";
  if (input.providerStatus === "INCOMPLETE") return input.current?.subscriptionStatus === "active" ? "INCOMPLETE_EXISTING" : "INCOMPLETE_NEW";
  if (input.providerStatus === "CANCELED") return input.current?.subscriptionStatus === "active" ? "CANCEL_SCHEDULED" : "CANCEL_EFFECTIVE_REQUIRES_SEPARATE_PROCESS";
  if (!input.period) return "REJECT";
  if (input.current && input.current.plan !== "free" && input.current.plan !== input.targetPlan) return "PLAN_CHANGE_MANUAL_REVIEW";
  if (!input.current || input.current.subscriptionStatus === "inactive") return "ACTIVATE";
  if (input.current.currentPeriodStart === input.period.periodStart && input.current.currentPeriodEnd === input.period.periodEnd) return "SAME_PERIOD_UPDATE";
  return "NEW_PERIOD_RENEWAL";
}
