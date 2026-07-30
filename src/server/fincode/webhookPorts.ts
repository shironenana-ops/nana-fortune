import type {
  FincodeEnvironment,
  FincodeSubscriptionEventType,
  FincodeSubscriptionStatus,
  FincodeTransitionDecision,
  NormalizedFincodeSubscriptionEvent,
} from "./webhookTypes";

export const FINCODE_WEBHOOK_LEDGER_RESERVE_RESULTS = [
  "RESERVED",
  "DUPLICATE_COMPLETED",
  "DUPLICATE_IN_PROGRESS",
  "CONFLICT",
  "UNAVAILABLE",
] as const;

export type FincodeWebhookLedgerReserveResult = typeof FINCODE_WEBHOOK_LEDGER_RESERVE_RESULTS[number];

export type FincodeWebhookDigestIdentity = {
  semanticEventKey: string;
  payloadFingerprint: string;
};

export interface FincodeWebhookLedgerPort {
  reserve(input: FincodeWebhookDigestIdentity & { ttlSeconds: number }): Promise<FincodeWebhookLedgerReserveResult>;
  fail(input: FincodeWebhookDigestIdentity & { retryableResultCode: string }): Promise<void>;
}

export const FINCODE_WEBHOOK_CUSTOMER_LOOKUP_RESULTS = [
  "FOUND",
  "NOT_FOUND",
  "CONFLICT",
] as const;

export type FincodeWebhookCustomerLookupResult =
  | {
      status: "FOUND";
      userReference: string;
      membershipSnapshot: FincodeWebhookMembershipSnapshot;
    }
  | { status: "NOT_FOUND" }
  | { status: "CONFLICT" };

export interface FincodeWebhookCustomerPort {
  findByOpaqueCustomerReference(customerReference: string): Promise<FincodeWebhookCustomerLookupResult>;
}

export type FincodeWebhookInternalPlan = "free" | "light" | "premium" | "UNCHANGED";

export type FincodeWebhookMembershipSnapshot = {
  version: number;
  plan: "free" | "light" | "premium";
  subscriptionStatus: "active" | "inactive";
  periodKey: string | null;
};

export type FincodeWebhookTrustedMembershipPeriod = {
  source: "TRUSTED_MEMBERSHIP_SOURCE";
  periodKey: string;
  periodEnd: string;
};

export type FincodeWebhookEntitlementMutation =
  | { kind: "NONE" }
  | {
      kind: "SET_MEMBERSHIP";
      plan: "free" | "light" | "premium";
      subscriptionStatus: "active" | "inactive";
      deepEnabled: boolean;
      monthlyVoiceLimit: 0 | 3 | 10;
      cancelAtPeriodEnd: boolean;
    }
  | { kind: "SET_CANCEL_AT_PERIOD_END" };

export type FincodeWebhookQuotaMutation =
  | { kind: "NONE" }
  | {
      kind: "CREATE_PERIOD_ALLOWANCE";
      periodKey: string;
      lightLimit: 5 | 20;
      preserveExistingUsage: true;
    };

export type FincodeWebhookBillingMutation =
  | { kind: "NONE" }
  | { kind: "RECORD_INCOMPLETE" }
  | { kind: "RECORD_MANUAL_REVIEW" };

export const FINCODE_WEBHOOK_ATOMIC_RESULT_CODES = [
  "WEBHOOK_COMPLETED",
  "ENTITLEMENT_APPLIED",
  "INCOMPLETE_RECORDED",
  "PLAN_CHANGE_MANUAL_REVIEW",
] as const;

export type FincodeWebhookAtomicResultCode = typeof FINCODE_WEBHOOK_ATOMIC_RESULT_CODES[number];

export type FincodeWebhookAtomicCompletionPlan = {
  decision: FincodeTransitionDecision;
  expectedMembership: FincodeWebhookMembershipSnapshot;
  plan: FincodeWebhookInternalPlan;
  finalLedgerState: "COMPLETED" | "MANUAL_REVIEW";
  period?: FincodeWebhookTrustedMembershipPeriod;
  entitlementMutation: FincodeWebhookEntitlementMutation;
  quotaMutation: FincodeWebhookQuotaMutation;
  billingMutation: FincodeWebhookBillingMutation;
  resultCode: FincodeWebhookAtomicResultCode;
  ledgerOnly: boolean;
};

export type FincodeWebhookAtomicCompletionRequest = FincodeWebhookDigestIdentity & {
  expectedLedgerState: "RESERVED";
  userReference: string;
  normalizedEvent: {
    environment: FincodeEnvironment;
    eventType: FincodeSubscriptionEventType;
    status: FincodeSubscriptionStatus;
  };
  completionPlan: FincodeWebhookAtomicCompletionPlan;
  correlationDigest: string;
  retentionTtlSeconds: number;
  completedAt: string;
};

export const FINCODE_WEBHOOK_ATOMIC_COMPLETION_RESULTS = [
  "COMPLETED",
  "ALREADY_COMPLETED",
  "CONDITIONAL_CONFLICT",
  "UNAVAILABLE",
  "RETRYABLE_FAILURE",
] as const;

export type FincodeWebhookAtomicCompletionResult =
  typeof FINCODE_WEBHOOK_ATOMIC_COMPLETION_RESULTS[number];

export interface FincodeWebhookAtomicCompletionPort {
  applyAndComplete(input: FincodeWebhookAtomicCompletionRequest): Promise<FincodeWebhookAtomicCompletionResult>;
}

export type FincodeWebhookAtomicCompletionPlanFactory = (input: {
  event: NormalizedFincodeSubscriptionEvent;
  userReference: string;
  membershipSnapshot: FincodeWebhookMembershipSnapshot;
  decision: FincodeTransitionDecision;
}) => FincodeWebhookAtomicCompletionPlan | null;

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const PERIOD_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const TRANSITION_DECISIONS: readonly FincodeTransitionDecision[] = [
  "NO_OP",
  "ACTIVATE_SUBSCRIPTION",
  "UPDATE_SUBSCRIPTION",
  "CANCEL_SUBSCRIPTION",
  "RECORD_INCOMPLETE",
  "REJECT",
];
const EVENT_TYPES = ["subscription.card.regist", "subscription.card.update", "subscription.card.delete"] as const;
const EVENT_STATUSES = ["ACTIVE", "RUNNING", "CANCELED", "INCOMPLETE"] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function isFincodeWebhookAtomicCompletionPlan(
  value: unknown,
): value is FincodeWebhookAtomicCompletionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<FincodeWebhookAtomicCompletionPlan>;
  const entitlement = plan.entitlementMutation;
  const quota = plan.quotaMutation;
  const billing = plan.billingMutation;
  const planKeys = [
    "billingMutation", "decision", "entitlementMutation", "expectedMembership", "finalLedgerState", "ledgerOnly", "plan",
    "quotaMutation", "resultCode", ...(plan.period ? ["period"] : []),
  ];
  if (!hasExactKeys(value, planKeys)) return false;
  if (!TRANSITION_DECISIONS.includes(plan.decision as FincodeTransitionDecision)) return false;
  const noMutation = entitlement?.kind === "NONE" && quota?.kind === "NONE" && billing?.kind === "NONE";
  if (plan.ledgerOnly !== noMutation) return false;
  if (!FINCODE_WEBHOOK_ATOMIC_RESULT_CODES.includes(plan.resultCode as FincodeWebhookAtomicResultCode)) return false;
  if (!["COMPLETED", "MANUAL_REVIEW"].includes(plan.finalLedgerState ?? "")) return false;
  if (!["free", "light", "premium", "UNCHANGED"].includes(plan.plan ?? "")) return false;
  if (!entitlement || !quota || !billing) return false;
  if (!plan.expectedMembership ||
      !hasExactKeys(plan.expectedMembership, ["periodKey", "plan", "subscriptionStatus", "version"]) ||
      !Number.isSafeInteger(plan.expectedMembership.version) || plan.expectedMembership.version < 0 ||
      !["free", "light", "premium"].includes(plan.expectedMembership.plan) ||
      !["active", "inactive"].includes(plan.expectedMembership.subscriptionStatus) ||
      !(plan.expectedMembership.periodKey === null || PERIOD_KEY.test(plan.expectedMembership.periodKey))) return false;
  if (!hasExactKeys(entitlement, entitlement.kind === "SET_MEMBERSHIP"
    ? ["cancelAtPeriodEnd", "deepEnabled", "kind", "monthlyVoiceLimit", "plan", "subscriptionStatus"]
    : ["kind"])) return false;
  if (!hasExactKeys(quota, quota.kind === "CREATE_PERIOD_ALLOWANCE"
    ? ["kind", "lightLimit", "periodKey", "preserveExistingUsage"]
    : ["kind"])) return false;
  if (!hasExactKeys(billing, ["kind"])) return false;
  if (!["NONE", "SET_MEMBERSHIP", "SET_CANCEL_AT_PERIOD_END"].includes(entitlement.kind)) return false;
  if (!["NONE", "CREATE_PERIOD_ALLOWANCE"].includes(quota.kind)) return false;
  if (!["NONE", "RECORD_INCOMPLETE", "RECORD_MANUAL_REVIEW"].includes(billing.kind)) return false;
  if (quota.kind === "CREATE_PERIOD_ALLOWANCE") {
    if (!plan.period || quota.periodKey !== plan.period.periodKey || !PERIOD_KEY.test(quota.periodKey) ||
        ![5, 20].includes(quota.lightLimit) || quota.preserveExistingUsage !== true) return false;
  }
  if (plan.period && (plan.period.source !== "TRUSTED_MEMBERSHIP_SOURCE" ||
      !hasExactKeys(plan.period, ["periodEnd", "periodKey", "source"]) ||
      !PERIOD_KEY.test(plan.period.periodKey) || !Number.isFinite(Date.parse(plan.period.periodEnd)))) return false;
  if (entitlement.kind === "SET_MEMBERSHIP" &&
      (!["free", "light", "premium"].includes(entitlement.plan) ||
       !["active", "inactive"].includes(entitlement.subscriptionStatus) ||
       typeof entitlement.deepEnabled !== "boolean" || typeof entitlement.cancelAtPeriodEnd !== "boolean" ||
       ![0, 3, 10].includes(entitlement.monthlyVoiceLimit))) return false;
  if (entitlement.kind === "SET_MEMBERSHIP") {
    const policyMatches =
      (entitlement.plan === "free" && entitlement.subscriptionStatus === "inactive" && !entitlement.deepEnabled && entitlement.monthlyVoiceLimit === 0) ||
      (entitlement.plan === "light" && entitlement.subscriptionStatus === "active" && !entitlement.deepEnabled && entitlement.monthlyVoiceLimit === 3) ||
      (entitlement.plan === "premium" && entitlement.subscriptionStatus === "active" && entitlement.deepEnabled && entitlement.monthlyVoiceLimit === 10);
    if (!policyMatches || plan.plan !== entitlement.plan) return false;
  }
  if (plan.decision === "RECORD_INCOMPLETE" &&
      (entitlement.kind !== "NONE" || quota.kind !== "NONE" || billing.kind !== "RECORD_INCOMPLETE")) return false;
  if (plan.resultCode === "PLAN_CHANGE_MANUAL_REVIEW" &&
      (entitlement.kind !== "NONE" || quota.kind !== "NONE" || billing.kind !== "RECORD_MANUAL_REVIEW")) return false;
  return true;
}

export function isFincodeWebhookAtomicCompletionRequest(
  value: unknown,
): value is FincodeWebhookAtomicCompletionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<FincodeWebhookAtomicCompletionRequest>;
  if (!hasExactKeys(value, [
    "completedAt", "completionPlan", "correlationDigest", "expectedLedgerState", "normalizedEvent",
    "payloadFingerprint", "retentionTtlSeconds", "semanticEventKey", "userReference",
  ])) return false;
  return request.expectedLedgerState === "RESERVED" &&
    typeof request.userReference === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(request.userReference) &&
    HEX_DIGEST.test(request.semanticEventKey ?? "") && HEX_DIGEST.test(request.payloadFingerprint ?? "") &&
    HEX_DIGEST.test(request.correlationDigest ?? "") &&
    Number.isSafeInteger(request.retentionTtlSeconds) && (request.retentionTtlSeconds ?? 0) > 0 &&
    typeof request.completedAt === "string" && Number.isFinite(Date.parse(request.completedAt)) &&
    !!request.normalizedEvent && hasExactKeys(request.normalizedEvent, ["environment", "eventType", "status"]) &&
    ["staging", "production"].includes(request.normalizedEvent.environment) &&
    EVENT_TYPES.includes(request.normalizedEvent.eventType) &&
    EVENT_STATUSES.includes(request.normalizedEvent.status) &&
    isFincodeWebhookAtomicCompletionPlan(request.completionPlan);
}

export type FincodeWebhookRetentionPolicy = {
  ttlSeconds: number;
  minimumTtlSeconds: number;
  maximumTtlSeconds: number;
};

export function validateFincodeWebhookRetentionPolicy(policy: FincodeWebhookRetentionPolicy): number {
  const values = [policy.ttlSeconds, policy.minimumTtlSeconds, policy.maximumTtlSeconds];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0) ||
      policy.minimumTtlSeconds > policy.maximumTtlSeconds ||
      policy.ttlSeconds < policy.minimumTtlSeconds || policy.ttlSeconds > policy.maximumTtlSeconds) {
    throw new Error("FINCODE_WEBHOOK_RETENTION_INVALID");
  }
  return policy.ttlSeconds;
}
