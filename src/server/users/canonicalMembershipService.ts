import { authenticateHeaders, type HeaderMap } from "../auth/sessionToken";
import { loadAuthenticatedMembershipContext, toPublicMembershipSummary } from "./membershipContext";
import type { UserRepository } from "./userRepository";

export async function getCanonicalMembershipStatus(input: {
  headers: HeaderMap;
  sessionSecret?: string;
  repository: UserRepository;
  nowEpochSeconds?: number;
}) {
  const session = authenticateHeaders({ headers: input.headers, secret: input.sessionSecret, nowEpochSeconds: input.nowEpochSeconds });
  const context = await loadAuthenticatedMembershipContext({ session, repository: input.repository });
  return toPublicMembershipSummary(context);
}
