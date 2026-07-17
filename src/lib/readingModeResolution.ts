import type { MembershipTier, ReadingPlan } from "./accessPolicy";
import {
  getMembershipEntitlements,
  type MembershipEntitlementInput,
  type MembershipEntitlements,
} from "./membershipEntitlements";

export type ReadingMode = ReadingPlan;

export type ReadingModeResolutionReason =
  | "default_mode"
  | "mode_allowed"
  | "unknown_mode"
  | "subscription_inactive"
  | "membership_required"
  | "deep_entitlement_required";

export type ReadingModeResolution = {
  allowed: boolean;
  requestedMode: ReadingMode | null;
  resolvedMode: ReadingMode;
  defaultMode: ReadingMode;
  availableModes: ReadingMode[];
  tier: MembershipTier;
  reason: ReadingModeResolutionReason;
};

export type ResolveReadingModeInput = {
  requestedMode?: unknown;
  membership?: MembershipEntitlementInput | null;
};

const READING_MODES = new Set<ReadingMode>(["free", "light", "deep"]);

export function normalizeReadingMode(value: unknown): ReadingMode | null {
  const mode = String(value ?? "").trim().toLowerCase();
  return READING_MODES.has(mode as ReadingMode) ? (mode as ReadingMode) : null;
}

export function getAvailableReadingModes(
  entitlements: MembershipEntitlements,
): ReadingMode[] {
  const modes: ReadingMode[] = ["free"];

  if (
    entitlements.isSubscriptionActive &&
    (entitlements.tier === "light" || entitlements.tier === "premium")
  ) {
    modes.push("light");
  }

  if (entitlements.canUseDeep) modes.push("deep");
  return modes;
}

export function getDefaultReadingMode(
  entitlements: MembershipEntitlements,
): ReadingMode {
  return getAvailableReadingModes(entitlements).includes("light") ? "light" : "free";
}

function getDeniedReason(
  requestedMode: ReadingMode,
  entitlements: MembershipEntitlements,
): ReadingModeResolutionReason {
  if (requestedMode === "deep") return "deep_entitlement_required";
  if (entitlements.tier === "free") return "membership_required";
  return "subscription_inactive";
}

/**
 * Resolves a requested reading mode from trusted membership attributes.
 *
 * This function deliberately knows nothing about browser state, payment
 * providers, or UI state. Callers must obtain membership attributes from an
 * authenticated server response before using the result as an authorization
 * decision.
 */
export function resolveReadingMode(input: ResolveReadingModeInput): ReadingModeResolution {
  const entitlements = getMembershipEntitlements(input.membership ?? {});
  const availableModes = getAvailableReadingModes(entitlements);
  const defaultMode = getDefaultReadingMode(entitlements);
  const hasRequestedMode = input.requestedMode !== undefined && input.requestedMode !== null;
  const requestedMode = normalizeReadingMode(input.requestedMode);

  if (!hasRequestedMode) {
    return {
      allowed: true,
      requestedMode: null,
      resolvedMode: defaultMode,
      defaultMode,
      availableModes,
      tier: entitlements.tier,
      reason: "default_mode",
    };
  }

  if (!requestedMode) {
    return {
      allowed: false,
      requestedMode: null,
      resolvedMode: "free",
      defaultMode,
      availableModes,
      tier: entitlements.tier,
      reason: "unknown_mode",
    };
  }

  if (!availableModes.includes(requestedMode)) {
    return {
      allowed: false,
      requestedMode,
      resolvedMode: "free",
      defaultMode,
      availableModes,
      tier: entitlements.tier,
      reason: getDeniedReason(requestedMode, entitlements),
    };
  }

  return {
    allowed: true,
    requestedMode,
    resolvedMode: requestedMode,
    defaultMode,
    availableModes,
    tier: entitlements.tier,
    reason: "mode_allowed",
  };
}
