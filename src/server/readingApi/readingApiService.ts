import { authenticateHeaders } from "../auth/sessionToken";
import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { prepareReadingRequest } from "../reading/prepareReadingRequest";
import { validateReadingRequest } from "../reading/readingRequest";
import { validateIdempotencyKey } from "../reading/idempotencyKey";
import { getServerReadingDate } from "../reading/serverReadingDate";
import { loadAuthenticatedMembershipContext } from "../users/membershipContext";
import { ServerFoundationError } from "../http/errors";
import { createReadingRequestFingerprint, createReadingRequestRef } from "../readingPersistence/requestFingerprint";
import { toPublicReadingResponse } from "./readingApiResponse";
import type { PublicReadingResponse, ReadingApiDependencies, ReadingApiRequest } from "./readingApiTypes";

function header(headers: ReadingApiRequest["headers"], name: string) {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export async function executeReadingApi(
  request: ReadingApiRequest,
  dependencies: ReadingApiDependencies,
): Promise<PublicReadingResponse> {
  const now = dependencies.clock.now();
  const session = authenticateHeaders({
    headers: request.headers,
    secret: dependencies.sessionSecret,
    nowEpochSeconds: Math.floor(now.getTime() / 1000),
  });
  const membershipContext = await loadAuthenticatedMembershipContext({
    session,
    repository: dependencies.repository,
  });
  const readingDate = getServerReadingDate({ now: () => now });
  const normalizedRequest = validateReadingRequest(request.rawBody, readingDate);
  const idempotencyKey = validateIdempotencyKey(header(request.headers, "Idempotency-Key"));
  const command = prepareReadingRequest({
    rawRequest: request.rawBody,
    idempotencyKey: header(request.headers, "Idempotency-Key"),
    membershipContext,
    clock: { now: () => now },
    requestId: request.requestId,
    audit: {
      sink: dependencies.auditSink,
      auditHashSecret: dependencies.auditHashSecret,
    },
  });
  if (command.resolvedMode === "deep" && !dependencies.deepEnabled) throw new ServerFoundationError("READING_DEEP_DISABLED");
  const requestRef = createReadingRequestRef({ userId: session.user_id, idempotencyKey, secret: dependencies.idempotencyHashSecret });
  const fingerprint = createReadingRequestFingerprint({ request: normalizedRequest, secret: dependencies.idempotencyHashSecret });
  const auditEvent = (event: string, outcome: "success" | "denied" | "error", errorCode?: string) => {
    const value = { requestId: request.requestId, event, outcome, errorCode, resolvedMode: command.resolvedMode } as const;
    if (dependencies.audit) dependencies.audit(value, session.user_id);
    else writeSafeAuditLog({ event: value, userId: session.user_id, auditHashSecret: dependencies.auditHashSecret, sink: dependencies.auditSink, now: dependencies.clock.now() });
  };
  let begun;
  try {
    begun = await dependencies.persistence.begin({ requestRef, fingerprint, userId: session.user_id, resolvedMode: command.resolvedMode, readingDate, now });
  } catch (error) {
    if (command.resolvedMode === "deep" && error instanceof ServerFoundationError) {
      const event = error.code === "READING_DEEP_MONTHLY_LIMIT_REACHED"
        ? "deep_quota_exhausted"
        : error.code === "READING_DEEP_RESERVATION_INCONSISTENT"
          ? "deep_quota_inconsistent"
          : "deep_quota_conflict";
      auditEvent(event, error.code === "READING_DEEP_MONTHLY_LIMIT_REACHED" ? "denied" : "error", error.code);
    }
    throw error;
  }
  if (begun.kind === "conflict") throw new ServerFoundationError("IDEMPOTENCY_CONFLICT");
  if (begun.kind === "in_progress") throw new ServerFoundationError("IDEMPOTENCY_IN_PROGRESS");
  if (begun.kind === "replay") return { ...begun.history, request_id: request.requestId };
  const reservation = begun.reservation;
  if (reservation.deep) auditEvent("deep_quota_reserved", "success");

  let reading;
  try {
    // Deep entitlement consumption remains intentionally out of scope.
    const canonical = dependencies.engineRunner(command.engineInput);
    reading = command.resolvedMode === "free"
      ? ({ ...canonical, rendering: { status: "canonical", provider: "canonical" } } as const)
      : await dependencies.renderReading({
          requestId: request.requestId,
          displayName: command.engineInput.name,
          question: command.engineInput.question,
          reading: canonical,
        });
  } catch (error) {
    const failed = {
      requestId: request.requestId,
      event: "reading_request_failed",
      outcome: "error" as const,
      errorCode: "INTERNAL_ERROR",
      resolvedMode: command.resolvedMode,
    };
    if (dependencies.audit) dependencies.audit(failed, session.user_id);
    else writeSafeAuditLog({ event: failed, userId: session.user_id, auditHashSecret: dependencies.auditHashSecret, sink: dependencies.auditSink, now });
    await dependencies.persistence.fail({ reservation, now: dependencies.clock.now(), category: "generation_failed" });
    if (reservation.deep) auditEvent("deep_quota_released", "success");
    throw error;
  }

  const event = {
    requestId: request.requestId,
    event: "reading_request_completed",
    outcome: "success" as const,
    resolvedMode: command.resolvedMode,
    membershipPlan: membershipContext.entitlements.tier,
    subscriptionActive: membershipContext.entitlements.isSubscriptionActive,
    deepEntitled: membershipContext.entitlements.canUseDeep,
    provider: reading.rendering.provider,
  };
  if (dependencies.audit) dependencies.audit(event, session.user_id);
  else writeSafeAuditLog({ event, userId: session.user_id, auditHashSecret: dependencies.auditHashSecret, sink: dependencies.auditSink, now });
  const publicResponse = toPublicReadingResponse(request.requestId, reading);
  const stored = await dependencies.persistence.complete({ reservation, userId: session.user_id, response: publicResponse, now: dependencies.clock.now() });
  if (reservation.deep) auditEvent("deep_quota_consumed", "success");
  return { ...stored, request_id: request.requestId };
}
