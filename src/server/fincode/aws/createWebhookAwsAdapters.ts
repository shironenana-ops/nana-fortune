import type { NormalizedFincodeSubscriptionEvent } from "../webhookTypes";
import type { FincodeWebhookAtomicCompletionPlanFactory, FincodeWebhookMembershipSnapshot } from "../webhookPorts";
import { DynamoFincodeAtomicCompletion } from "./dynamoAtomicCompletion";
import { DynamoFincodeCustomerMapping } from "./dynamoCustomerMapping";
import { DynamoFincodeWebhookLedger } from "./dynamoWebhookLedger";
import { SecretsManagerFincodeWebhookSignature } from "./secretsWebhookSignature";
import type { FincodeWebhookAwsConfig } from "./webhookAwsConfig";

type Sender = { send(command: unknown): Promise<unknown> };

function manualPlan(
  event: NormalizedFincodeSubscriptionEvent,
  membershipSnapshot: FincodeWebhookMembershipSnapshot,
  decision: Parameters<FincodeWebhookAtomicCompletionPlanFactory>[0]["decision"],
) {
  if (event.status === "INCOMPLETE" && decision === "RECORD_INCOMPLETE") return {
    decision, expectedMembership: membershipSnapshot, plan: "UNCHANGED" as const,
    finalLedgerState: "MANUAL_REVIEW" as const, entitlementMutation: { kind: "NONE" as const },
    quotaMutation: { kind: "NONE" as const }, billingMutation: { kind: "RECORD_INCOMPLETE" as const },
    resultCode: "INCOMPLETE_RECORDED" as const, ledgerOnly: false,
  };
  if (event.status === "CANCELED" && decision === "CANCEL_SUBSCRIPTION") return {
    decision, expectedMembership: membershipSnapshot, plan: "UNCHANGED" as const,
    finalLedgerState: "MANUAL_REVIEW" as const, entitlementMutation: { kind: "NONE" as const },
    quotaMutation: { kind: "NONE" as const }, billingMutation: { kind: "RECORD_MANUAL_REVIEW" as const },
    resultCode: "PLAN_CHANGE_MANUAL_REVIEW" as const, ledgerOnly: false,
  };
  return null;
}

/**
 * The provider event does not currently carry a reviewed contract period.
 * Active entitlement/quota plans therefore deliberately return null.
 */
export function createFailClosedWebhookCompletionPlanFactory(): FincodeWebhookAtomicCompletionPlanFactory {
  return ({ event, membershipSnapshot, decision }) => manualPlan(event, membershipSnapshot, decision);
}

export function createReviewedWebhookCompletionPlanFactory(
  planMapping: ReadonlyMap<string, "light" | "premium">,
): FincodeWebhookAtomicCompletionPlanFactory {
  return ({ event, membershipSnapshot, decision, trustedPeriod }) => {
    const manual = manualPlan(event, membershipSnapshot, decision);
    if (manual) return manual;
    const targetPlan = planMapping.get(event.planRef);
    if (!targetPlan || !trustedPeriod || (event.status !== "ACTIVE" && event.status !== "RUNNING")) return null;
    if (membershipSnapshot.subscriptionStatus === "active" && membershipSnapshot.plan !== targetPlan) return {
      decision, expectedMembership: membershipSnapshot, plan: "UNCHANGED" as const, finalLedgerState: "MANUAL_REVIEW" as const,
      period: trustedPeriod, entitlementMutation: { kind: "NONE" as const }, quotaMutation: { kind: "NONE" as const },
      billingMutation: { kind: "RECORD_MANUAL_REVIEW" as const }, resultCode: "PLAN_CHANGE_MANUAL_REVIEW" as const, ledgerOnly: false,
    };
    const samePeriod = membershipSnapshot.subscriptionStatus === "active" && membershipSnapshot.plan === targetPlan &&
      membershipSnapshot.currentPeriodStart === trustedPeriod.periodStart && membershipSnapshot.currentPeriodEnd === trustedPeriod.periodEnd;
    const lightLimit = targetPlan === "light" ? 5 as const : 20 as const;
    if (samePeriod) return {
      decision, expectedMembership: membershipSnapshot, plan: targetPlan, finalLedgerState: "COMPLETED" as const, period: trustedPeriod,
      entitlementMutation: { kind: "VERIFY_MEMBERSHIP" as const },
      quotaMutation: { kind: "VERIFY_PERIOD_ALLOWANCE" as const, periodId: trustedPeriod.periodId, expectedLimit: lightLimit, preserveExistingUsage: true as const },
      billingMutation: { kind: "NONE" as const }, resultCode: "WEBHOOK_COMPLETED" as const, ledgerOnly: false,
    };
    return {
      decision, expectedMembership: membershipSnapshot, plan: targetPlan, finalLedgerState: "COMPLETED" as const, period: trustedPeriod,
      entitlementMutation: {
        kind: "SET_MEMBERSHIP" as const, plan: targetPlan, subscriptionStatus: "active" as const,
        deepEnabled: targetPlan === "premium", monthlyVoiceLimit: targetPlan === "premium" ? 10 as const : 3 as const,
        cancelAtPeriodEnd: false,
      },
      quotaMutation: { kind: "CREATE_PERIOD_ALLOWANCE" as const, periodId: trustedPeriod.periodId, lightLimit, preserveExistingUsage: true as const },
      billingMutation: { kind: "NONE" as const }, resultCode: "ENTITLEMENT_APPLIED" as const, ledgerOnly: false,
    };
  };
}

export function createFincodeWebhookAwsAdapters(
  config: FincodeWebhookAwsConfig,
  clients: { dynamodb: Sender; secretsManager: Sender },
) {
  const ledger = new DynamoFincodeWebhookLedger(clients.dynamodb, config.ledgerTableName, config.environment);
  const customers = new DynamoFincodeCustomerMapping(
    clients.dynamodb, config.customerMappingTableName, config.usersTableName, config.environment,
  );
  const signature = new SecretsManagerFincodeWebhookSignature(
    clients.secretsManager, config.signatureSecretId, config.secretCacheTtlSeconds,
  );
  return {
    ledger, customers, signature,
    atomicCompletion: config.mutationAvailable ? new DynamoFincodeAtomicCompletion(clients.dynamodb, config) : undefined,
    completionPlanFactory: config.mutationAvailable ? createReviewedWebhookCompletionPlanFactory(config.planMapping) : undefined,
    planResolver: (planRef: string) => config.planMapping.get(planRef) ?? null,
  };
}
