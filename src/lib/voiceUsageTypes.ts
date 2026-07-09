export const VOICE_SLOT_SECONDS = 120;
export const VOICE_MAX_AUTO_SECONDS = 600;
export const VOICE_MAX_AUTO_SLOTS = 5;

export type UsageType = "light_fortune" | "deep_fortune" | "voice";

export type UsageAction =
  | "reserve"
  | "commit"
  | "release"
  | "failed"
  | "grant"
  | "adjust"
  | "expire";

export type CreditSource =
  | "subscription"
  | "extra_purchase"
  | "free_retry"
  | "admin_adjust";

export type VoiceRequestStatus =
  | "requested"
  | "reserved"
  | "generating"
  | "completed"
  | "failed"
  | "released"
  | "expired"
  | "manual_review";

export type FailureCategory =
  | "external_api_error"
  | "timeout"
  | "validation_error"
  | "quota_error"
  | "system_error"
  | "unknown";

export type RetryChargePolicy = "charge" | "free_retry" | "manual_review";

export const VOICE_FEATURE_FLAGS = {
  VOICE_GENERATION_ENABLED: "VOICE_GENERATION_ENABLED",
  VOICE_FREE_RETRY_ENABLED: "VOICE_FREE_RETRY_ENABLED",
  VOICE_MAX_AUTO_SECONDS: "VOICE_MAX_AUTO_SECONDS",
  VOICE_MAX_RETRY_COUNT: "VOICE_MAX_RETRY_COUNT"
} as const;

export type VoiceFeatureFlagName =
  (typeof VOICE_FEATURE_FLAGS)[keyof typeof VOICE_FEATURE_FLAGS];

export function calculateRequiredVoiceSlots(estimatedDurationSec: number): number {
  if (!Number.isFinite(estimatedDurationSec) || estimatedDurationSec <= 0) {
    return 1;
  }

  return Math.ceil(estimatedDurationSec / VOICE_SLOT_SECONDS);
}

export function isAutoVoiceGenerationAllowed(estimatedDurationSec: number): boolean {
  return (
    Number.isFinite(estimatedDurationSec) &&
    estimatedDurationSec > 0 &&
    estimatedDurationSec <= VOICE_MAX_AUTO_SECONDS
  );
}
