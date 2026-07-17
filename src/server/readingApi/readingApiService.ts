import { authenticateHeaders } from "../auth/sessionToken";
import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { prepareReadingRequest } from "../reading/prepareReadingRequest";
import { loadAuthenticatedMembershipContext } from "../users/membershipContext";
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

  let reading;
  try {
    // This executes generation only. History persistence, idempotency state and
    // deep entitlement reservation/consumption are intentionally not implemented.
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
  return toPublicReadingResponse(request.requestId, reading);
}
