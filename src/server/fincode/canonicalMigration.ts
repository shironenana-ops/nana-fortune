import {
  FINCODE_MEMBERSHIP_SCHEMA_VERSION,
  canonicalizeFincodeUtcTimestamp,
  parseFincodeMembershipRecordV1,
} from "./membershipSchema";

export type CanonicalMigrationDecision =
  | { status: "MIGRATABLE" | "NO_OP"; update: Record<string, unknown> }
  | { status: "MANUAL_REVIEW" | "BLOCKED" | "UNKNOWN_SCHEMA"; reason: string };

export type LegacyQuotaMigrationDecision = Exclude<CanonicalMigrationDecision, { status: "NO_OP" }>;

const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = (value: unknown) => canonicalizeFincodeUtcTimestamp(value);

export function planLegacyUserCanonicalMigration(input: {
  item: Record<string, unknown>;
  trustedPeriod?: { periodStart: string; periodEnd: string };
  now: string;
}): CanonicalMigrationDecision {
  if (parseFincodeMembershipRecordV1(input.item)) return { status: "NO_OP", update: {} };
  const plan = input.item.plan;
  const status = input.item.subscription_status;
  const used = integer(input.item.monthly_voice_used);
  const extra = integer(input.item.extra_voice_remaining);
  const updatedAt = iso(input.now);
  if (!updatedAt || !["free", "light", "premium"].includes(String(plan)) ||
      !["active", "inactive"].includes(String(status)) || used === null || extra === null) {
    return { status: "UNKNOWN_SCHEMA", reason: "LEGACY_MEMBERSHIP_SHAPE_INVALID" };
  }
  const policy = plan === "free"
    ? { subscription_status: "inactive", deep_enabled: false, monthly_voice_limit: 0 }
    : plan === "light"
      ? { subscription_status: "active", deep_enabled: false, monthly_voice_limit: 3 }
      : { subscription_status: "active", deep_enabled: true, monthly_voice_limit: 10 };
  if (status !== policy.subscription_status || input.item.deep_enabled !== policy.deep_enabled) {
    return { status: "MANUAL_REVIEW", reason: "LEGACY_ENTITLEMENT_POLICY_CONFLICT" };
  }
  if (plan !== "free" && (!input.trustedPeriod || !iso(input.trustedPeriod.periodStart) || !iso(input.trustedPeriod.periodEnd) ||
      Date.parse(input.trustedPeriod.periodStart) >= Date.parse(input.trustedPeriod.periodEnd))) {
    return { status: "MANUAL_REVIEW", reason: "TRUSTED_CONTRACT_PERIOD_REQUIRED" };
  }
  const start = plan === "free" ? null : new Date(input.trustedPeriod!.periodStart).toISOString();
  const end = plan === "free" ? null : new Date(input.trustedPeriod!.periodEnd).toISOString();
  const quota = classifyLegacyQuotaMigration({ plan: plan as "free" | "light" | "premium", used,
    legacyLimit: input.item.monthly_voice_limit, periodStatus: plan === "free" ? "RESOLVED" : "RESOLVED" });
  if (quota.status !== "MIGRATABLE") return quota;
  return { status: "MIGRATABLE", update: {
    membership_schema_version: FINCODE_MEMBERSHIP_SCHEMA_VERSION,
    membership_version: 1,
    plan,
    ...policy,
    monthly_voice_used: used,
    extra_voice_remaining: extra,
    cancel_at_period_end: typeof input.item.cancel_at_period_end === "boolean" ? input.item.cancel_at_period_end : false,
    ...(start && end ? { current_period_start: start, current_period_end: end } : {}),
    membership_source: "legacy_migration",
    membership_updated_at: updatedAt,
  } };
}

export function planLegacyHistoryCanonicalMigration(item: Record<string, unknown>): CanonicalMigrationDecision {
  const compatible = ["free", "light", "deep"].includes(String(item.resolved_mode)) &&
    typeof item.reading_date === "string" && typeof item.public_result === "string";
  if (item.schema_version === "shirone-reading-history-v1") {
    return compatible ? { status: "NO_OP", update: {} } : { status: "UNKNOWN_SCHEMA", reason: "CANONICAL_HISTORY_SHAPE_INVALID" };
  }
  const status = item.status;
  const source = item.source;
  const createdAt = iso(item.created_at);
  const updatedAt = iso(item.updated_at);
  if (!createdAt || !updatedAt || typeof status !== "string" || typeof source !== "string") {
    return { status: "UNKNOWN_SCHEMA", reason: "LEGACY_HISTORY_SHAPE_INVALID" };
  }
  if (!compatible || status !== "completed") return { status: "MANUAL_REVIEW", reason: "LEGACY_HISTORY_GENERATION_UNKNOWN" };
  return { status: "MIGRATABLE", update: {
    schema_version: "shirone-reading-history-v1",
    status,
    source: `legacy_migration:${source}`,
    created_at: createdAt,
    updated_at: updatedAt,
  } };
}

export function classifyLegacyQuotaMigration(input: {
  plan: "free" | "light" | "premium";
  used: unknown;
  legacyLimit: unknown;
  periodStatus: "RESOLVED" | "NOT_AVAILABLE" | "CONFLICT" | "UNAVAILABLE";
}): LegacyQuotaMigrationDecision {
  const used = integer(input.used);
  const legacyLimit = integer(input.legacyLimit);
  if (used === null || legacyLimit === null || used > legacyLimit) {
    return { status: "UNKNOWN_SCHEMA", reason: "LEGACY_QUOTA_SHAPE_INVALID" };
  }
  if (input.plan !== "free" && input.periodStatus === "NOT_AVAILABLE") {
    return { status: "MANUAL_REVIEW", reason: "TRUSTED_CONTRACT_PERIOD_REQUIRED" };
  }
  if (input.plan !== "free" && input.periodStatus !== "RESOLVED") {
    return { status: "BLOCKED", reason: "CONTRACT_PERIOD_SOURCE_UNSAFE" };
  }
  const canonicalLimit = input.plan === "premium" ? 10 : input.plan === "light" ? 3 : 0;
  if (used > canonicalLimit) {
    return { status: "MANUAL_REVIEW", reason: "LEGACY_MONTHLY_USAGE_EXCEEDS_CANONICAL_LIMIT" };
  }
  if (legacyLimit !== canonicalLimit) {
    return { status: "MANUAL_REVIEW", reason: "LEGACY_QUOTA_LIMIT_DIFFERS_FROM_CANONICAL" };
  }
  return { status: "MIGRATABLE", update: {} };
}
