export const FINCODE_SIGNATURE_HEADER = "Fincode-Signature";

export const FINCODE_SUBSCRIPTION_EVENTS = [
  "subscription.card.regist",
  "subscription.card.update",
  "subscription.card.delete",
] as const;

export const FINCODE_SUBSCRIPTION_STATUSES = [
  "ACTIVE",
  "RUNNING",
  "CANCELED",
  "INCOMPLETE",
] as const;

export type FincodeEnvironment = "staging" | "production";
export type FincodeSubscriptionEventType = typeof FINCODE_SUBSCRIPTION_EVENTS[number];
export type FincodeSubscriptionStatus = typeof FINCODE_SUBSCRIPTION_STATUSES[number];

export type FincodeWebhookErrorCode =
  | "WEBHOOK_DISABLED"
  | "WEBHOOK_METHOD_INVALID"
  | "WEBHOOK_CONTENT_TYPE_INVALID"
  | "WEBHOOK_BODY_TOO_LARGE"
  | "WEBHOOK_HTTP_EVENT_INVALID"
  | "WEBHOOK_BODY_ENCODING_INVALID"
  | "WEBHOOK_SIGNATURE_NOT_CONFIGURED"
  | "WEBHOOK_SIGNATURE_MISSING"
  | "WEBHOOK_SIGNATURE_AMBIGUOUS"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "WEBHOOK_JSON_INVALID"
  | "WEBHOOK_SCHEMA_INVALID"
  | "WEBHOOK_EVENT_UNSUPPORTED"
  | "WEBHOOK_STATUS_UNSUPPORTED"
  | "WEBHOOK_SUBSCRIPTION_REFERENCE_REQUIRED"
  | "WEBHOOK_CUSTOMER_REFERENCE_INVALID"
  | "WEBHOOK_SHOP_NOT_ALLOWED"
  | "WEBHOOK_PLAN_NOT_ALLOWED"
  | "WEBHOOK_PRODUCTION_IDENTIFIER_REJECTED";

export class FincodeWebhookError extends Error {
  constructor(public readonly code: FincodeWebhookErrorCode) {
    super(code);
    this.name = "FincodeWebhookError";
  }
}

export type FincodeWebhookHeaders = Record<string, string | readonly string[] | undefined>;

export type FincodeWebhookBoundary = {
  enabled: boolean;
  environment: FincodeEnvironment;
  customerReferencePrefix: string;
  allowedShopRefs: ReadonlySet<string>;
  allowedShopDigests?: ReadonlySet<string>;
  allowedPlanRefs: ReadonlySet<string>;
  productionIdentifiers?: ReadonlySet<string>;
};

export type ValidatedFincodeSubscriptionPayload = {
  event: FincodeSubscriptionEventType;
  shopId: string;
  subscriptionId: string;
  planId: string;
  customerId: string;
  status: FincodeSubscriptionStatus;
  processDate: string;
  startDate: string | null;
  stopDate: string | null;
  clientFields: readonly [string | null, string | null, string | null];
};

export type NormalizedFincodeSubscriptionEvent = {
  environment: FincodeEnvironment;
  eventType: FincodeSubscriptionEventType;
  shopRef: string;
  subscriptionRef: string;
  planRef: string;
  customerRef: string;
  status: FincodeSubscriptionStatus;
  processDate: string;
  startDate: string | null;
  stopDate: string | null;
  clientFields: readonly [string | null, string | null, string | null];
  semanticEventKey: string;
  payloadFingerprint: string;
};

export type FincodeTransitionDecision =
  | "NO_OP"
  | "ACTIVATE_SUBSCRIPTION"
  | "UPDATE_SUBSCRIPTION"
  | "CANCEL_SUBSCRIPTION"
  | "RECORD_INCOMPLETE"
  | "REJECT";

export type FincodeTransitionResult = {
  decision: FincodeTransitionDecision;
  reasonCode: string;
};

export type FincodeWebhookLedgerRecord = {
  semanticEventKey: string;
  payloadFingerprint: string;
  environment: FincodeEnvironment;
  eventType: FincodeSubscriptionEventType;
  status: FincodeSubscriptionStatus;
  decision: FincodeTransitionDecision;
};

export interface FincodeWebhookLedgerRepository {
  findBySemanticEventKey(semanticEventKey: string): Promise<FincodeWebhookLedgerRecord | null>;
}

export interface FincodeCustomerReferenceRepository {
  findUserReferenceByExternalCustomerReference(customerReference: string): Promise<string | null>;
}
