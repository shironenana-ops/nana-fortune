import {
  createPayloadFingerprint,
  createSemanticEventKey,
} from "./webhookIdempotency";
import type {
  FincodeEnvironment,
  NormalizedFincodeSubscriptionEvent,
  ValidatedFincodeSubscriptionPayload,
} from "./webhookTypes";

export function normalizeFincodeSubscriptionEvent(params: {
  environment: FincodeEnvironment;
  payload: ValidatedFincodeSubscriptionPayload;
}): NormalizedFincodeSubscriptionEvent {
  const semanticEventKey = createSemanticEventKey(params);
  const payloadFingerprint = createPayloadFingerprint(params);
  return {
    environment: params.environment,
    eventType: params.payload.event,
    shopRef: params.payload.shopId,
    subscriptionRef: params.payload.subscriptionId,
    planRef: params.payload.planId,
    customerRef: params.payload.customerId,
    status: params.payload.status,
    processDate: params.payload.processDate,
    startDate: params.payload.startDate,
    stopDate: params.payload.stopDate,
    clientFields: params.payload.clientFields,
    semanticEventKey,
    payloadFingerprint,
  };
}
