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
    completionPlanFactory: config.mutationAvailable ? createFailClosedWebhookCompletionPlanFactory() : undefined,
  };
}
