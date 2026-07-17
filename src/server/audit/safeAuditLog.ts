import { createHmac } from "node:crypto";

export type AuditEvent = {
  requestId: string;
  event: string;
  outcome: "success" | "denied" | "error";
  errorCode?: string;
  durationMs?: number;
  requestedMode?: string;
  resolvedMode?: string;
  membershipPlan?: string;
  subscriptionActive?: boolean;
  deepEntitled?: boolean;
  deployVersion?: string;
  engineVersion?: string;
  provider?: string;
  promptVersion?: string;
  inputCharacters?: number;
  outputCharacters?: number;
  inputTokens?: number;
  outputTokens?: number;
};

type AuditSink = (line: string) => void;

function clean(value: string, max = 128): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, max);
}

export function createAuditUserRef(userId: string, secret?: string): string | undefined {
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(userId, "utf8").digest("hex").slice(0, 24);
}

export function writeSafeAuditLog(params: {
  event: AuditEvent;
  userId?: string;
  auditHashSecret?: string;
  sink?: AuditSink;
  now?: Date;
}) {
  const { event } = params;
  const userRef = params.userId ? createAuditUserRef(params.userId, params.auditHashSecret) : undefined;
  const record = {
    timestamp: (params.now ?? new Date()).toISOString(),
    request_id: clean(event.requestId),
    event: clean(event.event),
    outcome: event.outcome,
    ...(event.errorCode ? { error_code: clean(event.errorCode) } : {}),
    ...(Number.isFinite(event.durationMs) ? { duration_ms: Math.max(0, Math.trunc(event.durationMs!)) } : {}),
    ...(event.requestedMode ? { requested_mode: clean(event.requestedMode, 16) } : {}),
    ...(event.resolvedMode ? { resolved_mode: clean(event.resolvedMode, 16) } : {}),
    ...(event.membershipPlan ? { membership_plan: clean(event.membershipPlan, 16) } : {}),
    ...(typeof event.subscriptionActive === "boolean" ? { subscription_active: event.subscriptionActive } : {}),
    ...(typeof event.deepEntitled === "boolean" ? { deep_entitled: event.deepEntitled } : {}),
    ...(event.deployVersion ? { deploy_version: clean(event.deployVersion, 64) } : {}),
    ...(event.engineVersion ? { engine_version: clean(event.engineVersion, 64) } : {}),
    ...(event.provider ? { provider: clean(event.provider, 32) } : {}),
    ...(event.promptVersion ? { prompt_version: clean(event.promptVersion, 64) } : {}),
    ...(Number.isFinite(event.inputCharacters) ? { input_characters: Math.max(0, Math.trunc(event.inputCharacters!)) } : {}),
    ...(Number.isFinite(event.outputCharacters) ? { output_characters: Math.max(0, Math.trunc(event.outputCharacters!)) } : {}),
    ...(Number.isFinite(event.inputTokens) ? { input_tokens: Math.max(0, Math.trunc(event.inputTokens!)) } : {}),
    ...(Number.isFinite(event.outputTokens) ? { output_tokens: Math.max(0, Math.trunc(event.outputTokens!)) } : {}),
    ...(userRef ? { user_ref: userRef } : {}),
  };
  const line = JSON.stringify(record);
  (params.sink ?? console.log)(line);
  return record;
}
