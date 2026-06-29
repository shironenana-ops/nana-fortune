export type MembershipTier = "free" | "light" | "premium";

export type ReadingPlan = "free" | "light" | "deep";

export type VoiceHistoryPurchase = {
  historyId: string;
  isVoicePurchased: boolean;
};

export type VoiceAccessInput = {
  membershipTier: MembershipTier;
  historyId?: string;
  voicePurchase?: VoiceHistoryPurchase | null;
};

const AVAILABLE_READING_PLANS: Record<MembershipTier, ReadingPlan[]> = {
  free: ["free"],
  light: ["free", "light"],
  premium: ["free", "light", "deep"]
};

export function getAvailableReadingPlans(tier: MembershipTier): ReadingPlan[] {
  return [...AVAILABLE_READING_PLANS[tier]];
}

export function canCreateReading(tier: MembershipTier, plan: ReadingPlan): boolean {
  return AVAILABLE_READING_PLANS[tier].includes(plan);
}

export function canViewHistory(viewerUserId: string, historyOwnerUserId: string): boolean {
  const viewer = viewerUserId.trim();
  const owner = historyOwnerUserId.trim();

  return Boolean(viewer && owner && viewer === owner);
}

export function canUseVoiceByMembership(tier: MembershipTier): boolean {
  return tier === "premium";
}

export function canUseVoiceForHistory(input: VoiceAccessInput): boolean {
  if (canUseVoiceByMembership(input.membershipTier)) return true;

  if (!input.historyId || !input.voicePurchase?.isVoicePurchased) {
    return false;
  }

  return input.voicePurchase.historyId === input.historyId;
}

