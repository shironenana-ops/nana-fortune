import { ServerFoundationError } from "../http/errors";

export type MembershipTier = "free" | "light" | "premium";
export type RateLimitReadingMode = "free" | "light" | "deep";
export type RatePolicyKey = "free/free" | "light/free" | "light/light" | "premium/free" | "premium/light" | "premium/deep";
export type RatePolicy = { max: number; windowSeconds: number };
export type ReadingRateLimitConfig = {
  tableName: string;
  hashSecret: string;
  policies: Record<RatePolicyKey, RatePolicy>;
  concurrency: { light: 1; deep: 1; leaseSeconds: number };
};

const POLICY_ENV: Record<RatePolicyKey, [string, string]> = {
  "free/free": ["READING_RATE_LIMIT_FREE_FREE_MAX", "READING_RATE_LIMIT_FREE_FREE_WINDOW_SECONDS"],
  "light/free": ["READING_RATE_LIMIT_LIGHT_FREE_MAX", "READING_RATE_LIMIT_LIGHT_FREE_WINDOW_SECONDS"],
  "light/light": ["READING_RATE_LIMIT_LIGHT_LIGHT_MAX", "READING_RATE_LIMIT_LIGHT_LIGHT_WINDOW_SECONDS"],
  "premium/free": ["READING_RATE_LIMIT_PREMIUM_FREE_MAX", "READING_RATE_LIMIT_PREMIUM_FREE_WINDOW_SECONDS"],
  "premium/light": ["READING_RATE_LIMIT_PREMIUM_LIGHT_MAX", "READING_RATE_LIMIT_PREMIUM_LIGHT_WINDOW_SECONDS"],
  "premium/deep": ["READING_RATE_LIMIT_PREMIUM_DEEP_MAX", "READING_RATE_LIMIT_PREMIUM_DEEP_WINDOW_SECONDS"],
};

function integer(env: Record<string, string | undefined>, key: string, min: number, max: number): number {
  const value = env[key];
  if (!value || !/^\d+$/u.test(value)) throw new ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED");
  return parsed;
}

export function ratePolicyKey(tier: MembershipTier, mode: RateLimitReadingMode): RatePolicyKey {
  const key = `${tier}/${mode}` as RatePolicyKey;
  if (!(key in POLICY_ENV)) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
  return key;
}

export function readReadingRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
  hashSecret = env.READING_IDEMPOTENCY_HASH_SECRET ?? "",
): ReadingRateLimitConfig {
  const tableName = env.READING_RATE_LIMIT_TABLE_NAME?.trim() ?? "";
  if (!tableName || tableName.length > 255 || hashSecret.length < 32 || hashSecret.length > 4096 || /[\r\n]/u.test(hashSecret)) {
    throw new ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED");
  }
  const policies = Object.fromEntries(Object.entries(POLICY_ENV).map(([scope, [maxKey, windowKey]]) => [
    scope,
    { max: integer(env, maxKey, 1, 10_000), windowSeconds: integer(env, windowKey, 1, 86_400) },
  ])) as Record<RatePolicyKey, RatePolicy>;
  const light = integer(env, "READING_CONCURRENCY_LIGHT_LIMIT", 1, 1);
  const deep = integer(env, "READING_CONCURRENCY_DEEP_LIMIT", 1, 1);
  return {
    tableName,
    hashSecret,
    policies,
    concurrency: { light: light as 1, deep: deep as 1, leaseSeconds: integer(env, "READING_CONCURRENCY_LEASE_SECONDS", 30, 3_600) },
  };
}

export function resolveRatePolicy(config: ReadingRateLimitConfig, tier: MembershipTier, mode: RateLimitReadingMode) {
  const scope = ratePolicyKey(tier, mode);
  const policy = config.policies[scope];
  if (!policy) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
  return { scope, policy };
}
