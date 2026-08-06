import type { FincodeMembershipRecordV1 } from "../fincode/membershipSchema";

export type PublicQuotaBalances = {
  light_monthly_limit: number;
  light_monthly_used: number;
  light_monthly_remaining: number;
  deep_monthly_limit: number;
  deep_monthly_used: number;
  deep_monthly_remaining: number;
};

export interface MembershipQuotaRepository {
  readBalances(input: {
    userId: string;
    membership: FincodeMembershipRecordV1;
    now: Date;
  }): Promise<PublicQuotaBalances>;
}
