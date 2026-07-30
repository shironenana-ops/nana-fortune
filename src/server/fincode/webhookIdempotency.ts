import { createHash } from "node:crypto";
import type {
  FincodeWebhookLedgerRecord,
  NormalizedFincodeSubscriptionEvent,
  ValidatedFincodeSubscriptionPayload,
  FincodeEnvironment,
} from "./webhookTypes";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalParts(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
}

export function createSemanticEventKey(params: {
  environment: FincodeEnvironment;
  payload: ValidatedFincodeSubscriptionPayload;
}): string {
  const { payload } = params;
  return digest(canonicalParts([
    "shirone-fincode-subscription-event-v1",
    params.environment,
    payload.shopId,
    payload.event,
    payload.subscriptionId,
    payload.processDate,
    payload.status,
  ]));
}

export function createPayloadFingerprint(params: {
  environment: FincodeEnvironment;
  payload: ValidatedFincodeSubscriptionPayload;
}): string {
  const { payload } = params;
  return digest(JSON.stringify({
    schema: "shirone-fincode-subscription-payload-v1",
    environment: params.environment,
    event: payload.event,
    shop_id: payload.shopId,
    subscription_id: payload.subscriptionId,
    plan_id: payload.planId,
    customer_id: payload.customerId,
    status: payload.status,
    process_date: payload.processDate,
    start_date: payload.startDate,
    stop_date: payload.stopDate,
    client_field_1: payload.clientFields[0],
    client_field_2: payload.clientFields[1],
    client_field_3: payload.clientFields[2],
  }));
}

export function classifyFincodeWebhookReplay(params: {
  incoming: NormalizedFincodeSubscriptionEvent;
  existing: FincodeWebhookLedgerRecord | null;
}): "new" | "duplicate" | "conflict" {
  if (!params.existing) return "new";
  if (params.existing.semanticEventKey !== params.incoming.semanticEventKey) return "new";
  return params.existing.payloadFingerprint === params.incoming.payloadFingerprint
    ? "duplicate"
    : "conflict";
}
