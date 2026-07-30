import { verifyFincodeWebhookSignature } from "./webhookSignature";
import { parseFincodeSubscriptionPayload, validateFincodeWebhookTransport } from "./webhookSchema";
import { normalizeFincodeSubscriptionEvent } from "./webhookNormalizer";
import type {
  FincodeWebhookBoundary,
  FincodeWebhookHeaders,
  NormalizedFincodeSubscriptionEvent,
} from "./webhookTypes";

export function validateAndNormalizeFincodeWebhook(params: {
  method: unknown;
  contentType: unknown;
  rawBody: unknown;
  headers: FincodeWebhookHeaders;
  expectedSignature?: string;
  boundary: FincodeWebhookBoundary;
}): NormalizedFincodeSubscriptionEvent {
  const rawBody = validateFincodeWebhookTransport(params);
  verifyFincodeWebhookSignature({
    headers: params.headers,
    expectedSignature: params.expectedSignature,
  });
  const payload = parseFincodeSubscriptionPayload(rawBody, params.boundary);
  return normalizeFincodeSubscriptionEvent({ environment: params.boundary.environment, payload });
}
