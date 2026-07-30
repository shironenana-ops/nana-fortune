import { createHash } from "node:crypto";
import { writeFincodeWebhookAuditLog, type FincodeWebhookAuditResultCode } from "./webhookAudit";
import {
  adaptFincodeWebhookHttpEvent,
  fincodeWebhookAcknowledgedResponse,
  fincodeWebhookRejectedResponse,
  fincodeWebhookRetryResponse,
  type FincodeWebhookHttpResponse,
} from "./webhookHttpAdapter";
import { normalizeFincodeSubscriptionEvent } from "./webhookNormalizer";
import {
  validateFincodeWebhookRetentionPolicy,
  type FincodeWebhookCustomerPort,
  type FincodeWebhookEntitlementWriterPort,
  type FincodeWebhookLedgerPort,
  type FincodeWebhookRetentionPolicy,
} from "./webhookPorts";
import { parseFincodeSubscriptionPayload } from "./webhookSchema";
import { verifyFincodeWebhookSignature } from "./webhookSignature";
import { decideFincodeSubscriptionTransition } from "./webhookTransition";
import {
  FincodeWebhookError,
  type FincodeEnvironment,
  type FincodeWebhookBoundary,
  type NormalizedFincodeSubscriptionEvent,
} from "./webhookTypes";

export type FincodeWebhookOrchestratorDependencies = {
  boundary: FincodeWebhookBoundary;
  expectedSignature?: string;
  retentionPolicy: FincodeWebhookRetentionPolicy;
  ledger: FincodeWebhookLedgerPort;
  customers: FincodeWebhookCustomerPort;
  entitlementWriter?: FincodeWebhookEntitlementWriterPort;
  auditSink?: (line: string) => void;
  now?: () => number;
};

const INVALID_REF = createHash("sha256").update("invalid-fincode-webhook-event", "utf8").digest("hex");
const SIGNATURE_REJECTIONS = new Set([
  "WEBHOOK_SIGNATURE_MISSING",
  "WEBHOOK_SIGNATURE_AMBIGUOUS",
  "WEBHOOK_SIGNATURE_INVALID",
]);

function audit(params: {
  dependencies: FincodeWebhookOrchestratorDependencies;
  correlationId: string;
  event?: NormalizedFincodeSubscriptionEvent;
  verificationOutcome: "accepted" | "denied" | "error";
  responseClassification: "acknowledged" | "retry" | "permanent_reject";
  resultCode: FincodeWebhookAuditResultCode;
  replayOutcome?: "new" | "duplicate" | "conflict";
  transitionDecision?: ReturnType<typeof decideFincodeSubscriptionTransition>["decision"];
  startedAt: number;
}): void {
  writeFincodeWebhookAuditLog({
    correlationId: params.correlationId,
    eventReference: params.event?.semanticEventKey ?? INVALID_REF,
    eventType: params.event?.eventType,
    environment: params.dependencies.boundary.environment,
    verificationOutcome: params.verificationOutcome,
    responseClassification: params.responseClassification,
    replayOutcome: params.replayOutcome,
    transitionDecision: params.transitionDecision,
    durationMs: Math.max(0, (params.dependencies.now ?? Date.now)() - params.startedAt),
    resultCode: params.resultCode,
  }, params.dependencies.auditSink ?? console.log);
}

async function markFailed(
  dependencies: FincodeWebhookOrchestratorDependencies,
  event: NormalizedFincodeSubscriptionEvent,
  retryableResultCode: string,
): Promise<void> {
  try {
    await dependencies.ledger.fail({
      semanticEventKey: event.semanticEventKey,
      payloadFingerprint: event.payloadFingerprint,
      retryableResultCode,
    });
  } catch {
    // The public result stays retryable. Provider/repository details are never surfaced.
  }
}

function rejectFromError(error: FincodeWebhookError): FincodeWebhookHttpResponse {
  if (SIGNATURE_REJECTIONS.has(error.code)) return fincodeWebhookRejectedResponse(401);
  if (error.code === "WEBHOOK_SIGNATURE_NOT_CONFIGURED" || error.code === "WEBHOOK_DISABLED") {
    return fincodeWebhookRetryResponse();
  }
  return fincodeWebhookRejectedResponse(400);
}

export async function orchestrateFincodeWebhook(
  event: unknown,
  dependencies: FincodeWebhookOrchestratorDependencies,
): Promise<FincodeWebhookHttpResponse> {
  const clock = dependencies.now ?? Date.now;
  const startedAt = clock();
  let correlationId = "invalid";

  // Kill switch is deliberately checked before any transport, signature, JSON, or repository work.
  if (!dependencies.boundary.enabled) {
    audit({ dependencies, correlationId, verificationOutcome: "denied", responseClassification: "retry", resultCode: "WEBHOOK_DISABLED", startedAt });
    return fincodeWebhookRetryResponse();
  }

  let adapted;
  let normalized: NormalizedFincodeSubscriptionEvent;
  try {
    adapted = adaptFincodeWebhookHttpEvent(event);
    correlationId = adapted.correlationId;
    verifyFincodeWebhookSignature({ headers: adapted.headers, expectedSignature: dependencies.expectedSignature });
    const payload = parseFincodeSubscriptionPayload(adapted.rawBody, dependencies.boundary);
    normalized = normalizeFincodeSubscriptionEvent({ environment: dependencies.boundary.environment, payload });
  } catch (error) {
    if (error instanceof FincodeWebhookError) {
      const response = rejectFromError(error);
      const signatureDenied = SIGNATURE_REJECTIONS.has(error.code);
      const configurationError = error.code === "WEBHOOK_SIGNATURE_NOT_CONFIGURED";
      audit({
        dependencies,
        correlationId,
        verificationOutcome: configurationError ? "error" : "denied",
        responseClassification: response.statusCode === 503 ? "retry" : "permanent_reject",
        resultCode: signatureDenied ? "WEBHOOK_SIGNATURE_DENIED" :
          configurationError ? "WEBHOOK_INTERNAL_ERROR" :
          error.code.includes("SHOP") || error.code.includes("PLAN") || error.code.includes("PRODUCTION") || error.code.includes("CUSTOMER")
            ? "WEBHOOK_ENVIRONMENT_DENIED"
            : error.code.includes("HTTP") || error.code.includes("METHOD") || error.code.includes("CONTENT") || error.code.includes("BODY")
              ? "WEBHOOK_TRANSPORT_DENIED"
              : "WEBHOOK_SCHEMA_DENIED",
        startedAt,
      });
      return response;
    }
    audit({ dependencies, correlationId, verificationOutcome: "error", responseClassification: "retry", resultCode: "WEBHOOK_INTERNAL_ERROR", startedAt });
    return fincodeWebhookRetryResponse();
  }

  let ttlSeconds: number;
  try {
    ttlSeconds = validateFincodeWebhookRetentionPolicy(dependencies.retentionPolicy);
  } catch {
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "error", responseClassification: "retry", resultCode: "WEBHOOK_INTERNAL_ERROR", startedAt });
    return fincodeWebhookRetryResponse();
  }

  const digestIdentity = {
    semanticEventKey: normalized.semanticEventKey,
    payloadFingerprint: normalized.payloadFingerprint,
  };
  let reservation;
  try {
    reservation = await dependencies.ledger.reserve({ ...digestIdentity, ttlSeconds });
  } catch {
    reservation = "UNAVAILABLE" as const;
  }
  if (!["RESERVED", "DUPLICATE_COMPLETED", "DUPLICATE_IN_PROGRESS", "CONFLICT", "UNAVAILABLE"].includes(reservation)) {
    reservation = "UNAVAILABLE";
  }

  if (reservation === "DUPLICATE_COMPLETED") {
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "accepted", responseClassification: "acknowledged", replayOutcome: "duplicate", resultCode: "WEBHOOK_DUPLICATE", startedAt });
    return fincodeWebhookAcknowledgedResponse();
  }
  if (reservation === "CONFLICT") {
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "denied", responseClassification: "permanent_reject", replayOutcome: "conflict", resultCode: "WEBHOOK_CONFLICT", startedAt });
    return fincodeWebhookRejectedResponse(409);
  }
  if (reservation === "DUPLICATE_IN_PROGRESS" || reservation === "UNAVAILABLE") {
    audit({
      dependencies,
      correlationId,
      event: normalized,
      verificationOutcome: "error",
      responseClassification: "retry",
      replayOutcome: reservation === "DUPLICATE_IN_PROGRESS" ? "duplicate" : undefined,
      resultCode: reservation === "DUPLICATE_IN_PROGRESS" ? "WEBHOOK_DUPLICATE_IN_PROGRESS" : "WEBHOOK_LEDGER_UNAVAILABLE",
      startedAt,
    });
    return fincodeWebhookRetryResponse();
  }

  let customer;
  try {
    customer = await dependencies.customers.findByOpaqueCustomerReference(normalized.customerRef);
  } catch {
    await markFailed(dependencies, normalized, "CUSTOMER_LOOKUP_UNAVAILABLE");
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "error", responseClassification: "retry", replayOutcome: "new", resultCode: "WEBHOOK_CUSTOMER_LOOKUP_UNAVAILABLE", startedAt });
    return fincodeWebhookRetryResponse();
  }
  if (!customer) {
    await markFailed(dependencies, normalized, "CUSTOMER_NOT_FOUND");
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "denied", responseClassification: "permanent_reject", replayOutcome: "new", resultCode: "WEBHOOK_CUSTOMER_NOT_FOUND", startedAt });
    return fincodeWebhookRejectedResponse(400);
  }

  const transition = decideFincodeSubscriptionTransition(normalized);
  if (transition.decision === "NO_OP") {
    try {
      await dependencies.ledger.complete({ ...digestIdentity, resultCode: "NO_OP" });
    } catch {
      audit({ dependencies, correlationId, event: normalized, verificationOutcome: "error", responseClassification: "retry", replayOutcome: "new", transitionDecision: transition.decision, resultCode: "WEBHOOK_LEDGER_UNAVAILABLE", startedAt });
      return fincodeWebhookRetryResponse();
    }
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "accepted", responseClassification: "acknowledged", replayOutcome: "new", transitionDecision: transition.decision, resultCode: "WEBHOOK_ACCEPTED", startedAt });
    return fincodeWebhookAcknowledgedResponse();
  }

  // Current contract intentionally forbids all entitlement mutation. Merely injecting a writer cannot bypass it.
  if (transition.mutationAllowed !== true || !dependencies.entitlementWriter) {
    await markFailed(dependencies, normalized, "MUTATION_NOT_AVAILABLE");
    audit({ dependencies, correlationId, event: normalized, verificationOutcome: "error", responseClassification: "retry", replayOutcome: "new", transitionDecision: transition.decision, resultCode: "WEBHOOK_MUTATION_NOT_AVAILABLE", startedAt });
    return fincodeWebhookRetryResponse();
  }

  // This branch is unreachable while FincodeTransitionResult.mutationAllowed is the literal false.
  await markFailed(dependencies, normalized, "MUTATION_NOT_AVAILABLE");
  return fincodeWebhookRetryResponse();
}
