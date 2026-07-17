import { getMembershipEntitlements } from "../../lib/membershipEntitlements";
import { ServerFoundationError } from "../http/errors";
import type { SessionTokenPayload } from "../auth/sessionToken";
import type { UserRepository } from "./userRepository";

export async function loadAuthenticatedMembershipContext(params: {
  session: SessionTokenPayload;
  repository: UserRepository;
}) {
  const membership = await params.repository.findMembershipByUserId(params.session.user_id);
  if (!membership) throw new ServerFoundationError("USER_NOT_FOUND");
  return {
    userId: params.session.user_id,
    membership,
    entitlements: getMembershipEntitlements(membership),
  };
}

export function toPublicMembershipSummary(context: Awaited<ReturnType<typeof loadAuthenticatedMembershipContext>>) {
  const { entitlements } = context;
  return {
    plan: entitlements.tier,
    subscription_status: entitlements.subscriptionStatus,
    deep_available: entitlements.canUseDeep,
    monthly_voice_limit: entitlements.monthlyVoiceLimit,
    monthly_voice_used: entitlements.monthlyVoiceUsed,
    monthly_voice_remaining: entitlements.monthlyVoiceRemaining,
    extra_voice_remaining: entitlements.extraVoiceRemaining,
  };
}
