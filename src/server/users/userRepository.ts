export type TrustedMembershipRecord = {
  plan?: unknown;
  subscription_status?: unknown;
  deep_enabled?: unknown;
  monthly_voice_limit?: unknown;
  monthly_voice_used?: unknown;
  extra_voice_remaining?: unknown;
  cancel_at_period_end?: unknown;
  current_period_end?: unknown;
};

export interface UserRepository {
  findMembershipByUserId(userId: string): Promise<TrustedMembershipRecord | null>;
}
