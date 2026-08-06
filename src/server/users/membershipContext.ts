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
    current_period_start: context.membership.current_period_start ?? null,
    current_period_end: context.membership.current_period_end ?? null,
    membership_version: Number(context.membership.membership_version ?? 0),
    membership_schema_version: String(context.membership.membership_schema_version ?? ""),
    deep_available: entitlements.canUseDeep,
    monthly_voice_limit: entitlements.monthlyVoiceLimit,
    monthly_voice_used: entitlements.monthlyVoiceUsed,
    monthly_voice_remaining: entitlements.monthlyVoiceRemaining,
    extra_voice_remaining: entitlements.extraVoiceRemaining,
  };
}
