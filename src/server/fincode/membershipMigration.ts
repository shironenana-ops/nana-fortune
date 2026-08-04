import { parseFincodeMembershipRecordV1 } from "./membershipSchema";

export type MembershipMigrationStatus = "READY" | "NO_OP" | "CONFLICT" | "MANUAL_REVIEW" | "INVALID";
export type MembershipMigrationCandidate = {
  targetRef: string;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  trustedPeriod?: { periodStart: string; periodEnd: string };
};
export type MembershipMigrationResult = { targetDigest: string; status: MembershipMigrationStatus; reason: string };

const SAFE_REF = /^[A-Za-z0-9_-]{8,128}$/u;
const digest = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export async function planFincodeMembershipMigration(input: {
  environment: "staging" | "production";
  candidates: readonly MembershipMigrationCandidate[];
  allowedTargetRefs: ReadonlySet<string>;
}): Promise<MembershipMigrationResult[]> {
  if (input.environment !== "staging") throw new Error("FINCODE_MIGRATION_PRODUCTION_DENIED");
  if (input.candidates.length === 0 || input.candidates.length > 100) throw new Error("FINCODE_MIGRATION_SCOPE_INVALID");
  const results: MembershipMigrationResult[] = [];
  for (const candidate of input.candidates) {
    const targetDigest = await digest(candidate.targetRef);
    if (!SAFE_REF.test(candidate.targetRef) || !input.allowedTargetRefs.has(candidate.targetRef)) {
      results.push({ targetDigest, status: "INVALID", reason: "TARGET_NOT_ALLOWED" }); continue;
    }
    const current = parseFincodeMembershipRecordV1(candidate.current);
    const proposed = parseFincodeMembershipRecordV1(candidate.proposed);
    if (!proposed) { results.push({ targetDigest, status: "INVALID", reason: "PROPOSED_SCHEMA_INVALID" }); continue; }
    if (proposed.subscriptionStatus === "active" && (!candidate.trustedPeriod || proposed.currentPeriodStart !== candidate.trustedPeriod.periodStart || proposed.currentPeriodEnd !== candidate.trustedPeriod.periodEnd)) {
      results.push({ targetDigest, status: "MANUAL_REVIEW", reason: "TRUSTED_PERIOD_REQUIRED" }); continue;
    }
    if (current && JSON.stringify(candidate.current) === JSON.stringify(candidate.proposed)) {
      results.push({ targetDigest, status: "NO_OP", reason: "ALREADY_CURRENT" }); continue;
    }
    if (current && proposed.membershipVersion <= current.membershipVersion) {
      results.push({ targetDigest, status: "CONFLICT", reason: "VERSION_NOT_ADVANCED" }); continue;
    }
    results.push({ targetDigest, status: "READY", reason: "EXPLICIT_STAGING_UPDATE" });
  }
  return results;
}
