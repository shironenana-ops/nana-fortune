import { authenticateHeaders, type HeaderMap } from "../auth/sessionToken";
import { parseFincodeMembershipRecordV1 } from "../fincode/membershipSchema";
import { ServerFoundationError } from "../http/errors";
import { loadAuthenticatedMembershipContext, toPublicMembershipSummary } from "./membershipContext";
import type { MembershipQuotaRepository } from "./membershipQuotaRepository";
import type { UserRepository } from "./userRepository";

export async function getCanonicalMembershipStatus(input: {
  headers: HeaderMap;
  sessionSecret?: string;
  repository: UserRepository;
  quotaRepository?: MembershipQuotaRepository;
  requireCanonicalMembership?: boolean;
  now?: Date;
  nowEpochSeconds?: number;
}) {
  const session = authenticateHeaders({ headers: input.headers, secret: input.sessionSecret, nowEpochSeconds: input.nowEpochSeconds });
  const context = await loadAuthenticatedMembershipContext({ session, repository: input.repository });
  const canonical = parseFincodeMembershipRecordV1(context.membership);
  if (input.requireCanonicalMembership && !canonical) throw new ServerFoundationError("MEMBERSHIP_STATE_INVALID");
  const summary = toPublicMembershipSummary(context);
  if (!input.quotaRepository) return summary;
  if (!canonical) throw new ServerFoundationError("MEMBERSHIP_STATE_INVALID");
  const balances = await input.quotaRepository.readBalances({
    userId: session.user_id,
    membership: canonical,
    now: input.now ?? new Date(),
  });
  return { ...summary, ...balances };
}
