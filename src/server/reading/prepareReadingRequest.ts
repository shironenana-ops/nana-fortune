import type { MembershipEntitlements } from "../../lib/membershipEntitlements";
import { getDefaultReadingMode, resolveReadingMode, type ReadingMode } from "../../lib/readingModeResolution";
import type { ShironeEngineInput } from "../../lib/shironeEngine";
import { writeSafeAuditLog, type AuditEvent } from "../audit/safeAuditLog";
import { ServerFoundationError } from "../http/errors";
import type { TrustedMembershipRecord } from "../users/userRepository";
import { validateIdempotencyKey, type ValidatedIdempotencyKey } from "./idempotencyKey";
import { validateReadingRequest } from "./readingRequest";
import { getServerReadingDate, type Clock } from "./serverReadingDate";

export type PreparedReadingCommand = {
  idempotencyKey: ValidatedIdempotencyKey;
  userId: string;
  requestedMode: ReadingMode;
  resolvedMode: ReadingMode;
  engineInput: Required<Pick<ShironeEngineInput, "name" | "birthDate" | "today" | "plan">> &
    Pick<ShironeEngineInput, "question">;
};

export type ReadingMembershipContext = {
  userId: string;
  membership: TrustedMembershipRecord;
  entitlements: MembershipEntitlements;
};

type AuditOptions = {
  sink?: (line: string) => void;
  auditHashSecret?: string;
  deployVersion?: string;
  engineVersion?: string;
};

function audit(context: ReadingMembershipContext, requestId: string, options: AuditOptions | undefined, event: AuditEvent, now: Date) {
  writeSafeAuditLog({
    event: {
      ...event,
      requestId,
      membershipPlan: context.entitlements.tier,
      subscriptionActive: context.entitlements.isSubscriptionActive,
      deepEntitled: context.entitlements.canUseDeep,
      deployVersion: options?.deployVersion,
      engineVersion: options?.engineVersion,
    },
    userId: context.userId,
    auditHashSecret: options?.auditHashSecret,
    sink: options?.sink,
    now,
  });
}

export function prepareReadingRequest(params: {
  rawRequest: unknown;
  idempotencyKey: unknown;
  membershipContext: ReadingMembershipContext;
  clock: Clock;
  requestId: string;
  audit?: AuditOptions;
}): PreparedReadingCommand {
  const startedAt = params.clock.now();
  let requestedMode: ReadingMode | undefined;
  let resolvedMode: ReadingMode | undefined;
  try {
    const serverToday = getServerReadingDate({ now: () => startedAt });
    const request = validateReadingRequest(params.rawRequest, serverToday);
    const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
    requestedMode = request.requestedMode ?? getDefaultReadingMode(params.membershipContext.entitlements);
    const resolution = resolveReadingMode({ requestedMode, membership: params.membershipContext.membership });
    if (!resolution.allowed) throw new ServerFoundationError("READING_MODE_NOT_AVAILABLE");
    resolvedMode = resolution.resolvedMode;
    const command: PreparedReadingCommand = {
      idempotencyKey,
      userId: params.membershipContext.userId,
      requestedMode,
      resolvedMode,
      engineInput: {
        name: request.name,
        birthDate: request.birthDate,
        ...(request.question ? { question: request.question } : {}),
        today: serverToday,
        plan: resolvedMode,
      },
    };
    audit(params.membershipContext, params.requestId, params.audit, {
      requestId: params.requestId,
      event: "reading_request_prepared",
      outcome: "success",
      durationMs: 0,
      requestedMode,
      resolvedMode,
    }, startedAt);
    return command;
  } catch (error) {
    const code = error instanceof ServerFoundationError ? error.code : "INTERNAL_ERROR";
    audit(params.membershipContext, params.requestId, params.audit, {
      requestId: params.requestId,
      event: "reading_request_rejected",
      outcome: code === "INTERNAL_ERROR" ? "error" : "denied",
      errorCode: code,
      durationMs: 0,
      requestedMode,
      resolvedMode,
    }, startedAt);
    throw error;
  }
}
