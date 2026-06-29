import type { MembershipTier, ReadingPlan } from "./accessPolicy";
import { getAvailableReadingPlans } from "./accessPolicy";

export type MembershipDisplayInfo = {
  tier: MembershipTier;
  label: string;
  description: string;
  availablePlans: ReadingPlan[];
};

const MEMBERSHIP_TIERS = new Set<MembershipTier>(["free", "light", "premium"]);

const MEMBERSHIP_LABELS: Record<MembershipTier, string> = {
  free: "無料会員",
  light: "ライト会員",
  premium: "プレミアム会員"
};

const MEMBERSHIP_DESCRIPTIONS: Record<MembershipTier, string> = {
  free: "今日の流れを短く受け取れます。新しく作れる鑑定は無料鑑定です。",
  light: "無料鑑定とライト鑑定を新しく作れる想定です。",
  premium: "無料鑑定、ライト鑑定、深掘り鑑定を新しく作れる想定です。"
};

export function getDefaultMembershipTier(): MembershipTier {
  return "free";
}

export function isMembershipTier(value: unknown): value is MembershipTier {
  return typeof value === "string" && MEMBERSHIP_TIERS.has(value as MembershipTier);
}

export function normalizeMembershipTier(value: unknown): MembershipTier {
  const tier = String(value ?? "").trim().toLowerCase();

  if (isMembershipTier(tier)) return tier;
  if (tier === "normal" || tier === "member") return "light";

  return getDefaultMembershipTier();
}

export function getMembershipTierLabel(tier: MembershipTier): string {
  return MEMBERSHIP_LABELS[tier];
}

export function getMembershipTierDescription(tier: MembershipTier): string {
  return MEMBERSHIP_DESCRIPTIONS[tier];
}

export function getMembershipDisplayInfo(value: unknown): MembershipDisplayInfo {
  const tier = normalizeMembershipTier(value);

  return {
    tier,
    label: getMembershipTierLabel(tier),
    description: getMembershipTierDescription(tier),
    availablePlans: getAvailableReadingPlans(tier)
  };
}
