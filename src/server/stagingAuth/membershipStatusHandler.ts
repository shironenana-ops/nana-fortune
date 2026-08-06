import {
  createMembershipStatusHandler,
  MEMBERSHIP_OPTIONS_ROUTE_KEY,
  MEMBERSHIP_ROUTE_KEY,
} from "../membershipStatus/membershipStatusHandler";
import type { MembershipQuotaRepository } from "../users/membershipQuotaRepository";
import type { UserRepository } from "../users/userRepository";

export const STAGING_MEMBERSHIP_ROUTE_KEY = MEMBERSHIP_ROUTE_KEY;
export const STAGING_MEMBERSHIP_OPTIONS_ROUTE_KEY = MEMBERSHIP_OPTIONS_ROUTE_KEY;
export const LOCAL_STAGING_ORIGINS = new Set(["http://127.0.0.1:4321", "http://localhost:4321"]);

export function createStagingMembershipStatusHandler(
  config: { enabled: boolean; allowedOrigins: ReadonlySet<string> },
  dependencies: {
    repository: UserRepository;
    quotaRepository?: MembershipQuotaRepository;
    getSessionSecret(): Promise<string>;
    auditSink?: (line: string) => void;
  },
) {
  return createMembershipStatusHandler({
    ...config,
    disabledErrorCode: "STAGING_MEMBERSHIP_STATUS_DISABLED",
    auditEvent: "staging_membership_status_rejected",
    requireCanonicalMembership: false,
  }, dependencies);
}
