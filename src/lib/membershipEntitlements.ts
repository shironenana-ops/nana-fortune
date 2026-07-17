import { normalizeMembershipTier } from "./membership";
import type { MembershipTier } from "./accessPolicy";

export type MembershipEntitlementInput = {
  plan?: unknown;
  subscription_status?: unknown;
  deep_enabled?: unknown;
  monthly_voice_limit?: unknown;
  monthly_voice_used?: unknown;
  extra_voice_remaining?: unknown;
};

export type MembershipEntitlements = {
  tier: MembershipTier;
  subscriptionStatus: string;
  isSubscriptionActive: boolean;
  canUseDeep: boolean;
  monthlyVoiceLimit: number;
  monthlyVoiceUsed: number;
  monthlyVoiceRemaining: number;
  extraVoiceRemaining: number;
  canUseMonthlyVoice: boolean;
  canUseExtraVoice: boolean;
  canUseVoice: boolean;
};

function toNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(Math.trunc(number), 0);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function normalizeSubscriptionStatus(value: unknown): string {
  return String(value ?? "inactive").trim().toLowerCase() || "inactive";
}

export function getMembershipEntitlements(
  input: MembershipEntitlementInput,
): MembershipEntitlements {
  const tier = normalizeMembershipTier(input.plan);
  const subscriptionStatus = normalizeSubscriptionStatus(input.subscription_status);
  const isSubscriptionActive = subscriptionStatus === "active";
  const monthlyVoiceLimit = toNonNegativeInteger(input.monthly_voice_limit);
  const monthlyVoiceUsed = toNonNegativeInteger(input.monthly_voice_used);
  const monthlyVoiceRemaining = Math.max(monthlyVoiceLimit - monthlyVoiceUsed, 0);
  const extraVoiceRemaining = toNonNegativeInteger(input.extra_voice_remaining);
  const canUseMonthlyVoice =
    tier === "premium" && isSubscriptionActive && monthlyVoiceRemaining > 0;
  const canUseExtraVoice = extraVoiceRemaining > 0;

  return {
    tier,
    subscriptionStatus,
    isSubscriptionActive,
    canUseDeep:
      tier === "premium" && isSubscriptionActive && toBoolean(input.deep_enabled),
    monthlyVoiceLimit,
    monthlyVoiceUsed,
    monthlyVoiceRemaining,
    extraVoiceRemaining,
    canUseMonthlyVoice,
    canUseExtraVoice,
    canUseVoice: canUseMonthlyVoice || canUseExtraVoice,
  };
}
