import type {
  FincodeEnvironment,
  FincodeSubscriptionEventType,
  FincodeTransitionDecision,
} from "./webhookTypes";

export type FincodeWebhookAuditInput = {
  correlationId: string;
  eventReference: string;
  eventType?: FincodeSubscriptionEventType;
  environment: FincodeEnvironment;
  verificationOutcome: "accepted" | "denied" | "error";
  replayOutcome?: "new" | "duplicate" | "conflict";
  transitionDecision?: FincodeTransitionDecision;
  durationMs?: number;
  resultCode: FincodeWebhookAuditResultCode;
};

export const FINCODE_WEBHOOK_AUDIT_RESULT_CODES = [
  "WEBHOOK_ACCEPTED",
  "WEBHOOK_DUPLICATE",
  "WEBHOOK_CONFLICT",
  "WEBHOOK_SIGNATURE_DENIED",
  "WEBHOOK_SCHEMA_DENIED",
  "WEBHOOK_ENVIRONMENT_DENIED",
  "WEBHOOK_DISABLED",
  "WEBHOOK_INTERNAL_ERROR",
] as const;

export type FincodeWebhookAuditResultCode = typeof FINCODE_WEBHOOK_AUDIT_RESULT_CODES[number];
const RESULT_CODES = new Set<string>(FINCODE_WEBHOOK_AUDIT_RESULT_CODES);

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, max);
}

export function createFincodeWebhookAuditRecord(input: FincodeWebhookAuditInput) {
  const safeCorrelationId = /^[A-Za-z0-9_-]{1,128}$/u.test(input.correlationId)
    ? input.correlationId
    : "invalid";
  const safeResultCode = RESULT_CODES.has(input.resultCode)
    ? input.resultCode
    : "WEBHOOK_INTERNAL_ERROR";
  return {
    timestamp: new Date().toISOString(),
    correlation_id: clean(safeCorrelationId, 128),
    event_ref: /^[0-9a-f]{64}$/u.test(input.eventReference) ? input.eventReference : "invalid",
    environment: input.environment,
    verification_outcome: input.verificationOutcome,
    ...(input.eventType ? { event_type: input.eventType } : {}),
    ...(input.replayOutcome ? { replay_outcome: input.replayOutcome } : {}),
    ...(input.transitionDecision ? { transition_decision: input.transitionDecision } : {}),
    ...(Number.isFinite(input.durationMs) ? { duration_ms: Math.max(0, Math.trunc(input.durationMs!)) } : {}),
    result_code: safeResultCode,
  };
}

export function writeFincodeWebhookAuditLog(
  input: FincodeWebhookAuditInput,
  sink: (line: string) => void = console.log,
) {
  const record = createFincodeWebhookAuditRecord(input);
  sink(JSON.stringify(record));
  return record;
}
