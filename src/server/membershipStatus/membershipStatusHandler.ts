import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { ServerFoundationError, toSafeErrorResponse, type ServerErrorCode } from "../http/errors";
import { createRequestId } from "../http/requestId";
import type { ApiGatewayV2Event, LambdaHttpResponse } from "../readingApi/readingApiTypes";
import { getCanonicalMembershipStatus } from "../users/canonicalMembershipService";
import type { MembershipQuotaRepository } from "../users/membershipQuotaRepository";
import type { UserRepository } from "../users/userRepository";

export const MEMBERSHIP_ROUTE_KEY = "GET /membership/status";
export const MEMBERSHIP_OPTIONS_ROUTE_KEY = "OPTIONS /membership/status";

type Dependencies = {
  repository: UserRepository;
  quotaRepository?: MembershipQuotaRepository;
  getSessionSecret(): Promise<string>;
  auditSink?: (line: string) => void;
};

type Config = {
  enabled: boolean;
  allowedOrigins: ReadonlySet<string>;
  disabledErrorCode: ServerErrorCode;
  auditEvent: string;
  requireCanonicalMembership: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function context(event: ApiGatewayV2Event) {
  if (event.version !== "2.0" || !record(event.requestContext)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const http = event.requestContext.http;
  if (!record(http) || typeof http.method !== "string") throw new ServerFoundationError("HTTP_EVENT_INVALID");
  return {
    method: http.method.toUpperCase(),
    requestId: typeof event.requestContext.requestId === "string" ? event.requestContext.requestId : undefined,
  };
}

function headers(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!record(value)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!name || name in result || /[\r\n:]/u.test(rawName) || typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) {
      throw new ServerFoundationError("HTTP_EVENT_INVALID");
    }
    result[name] = rawValue;
  }
  return result;
}

function cors(input: Record<string, string>, method: string, allowed: ReadonlySet<string>): Record<string, string> {
  const origin = input.origin;
  if (origin === undefined) return { Vary: "Origin" };
  if (!allowed.has(origin) || origin === "*" || origin === "null") throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  if (method === "OPTIONS") {
    const requestedMethod = input["access-control-request-method"];
    const requestedHeaders = (input["access-control-request-headers"] ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (requestedMethod !== "GET" || requestedHeaders.some((value) => value !== "authorization")) throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function response(statusCode: number, requestId: string, body: unknown, corsHeaders: Record<string, string>): LambdaHttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId, ...corsHeaders },
    body: statusCode === 204 ? "" : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

export function createMembershipStatusHandler(config: Config, dependencies: Dependencies) {
  return async (event: ApiGatewayV2Event): Promise<LambdaHttpResponse> => {
    let requestId = createRequestId();
    let corsHeaders: Record<string, string> = {};
    try {
      const request = context(event);
      requestId = createRequestId(request.requestId);
      if (request.method !== "GET" && request.method !== "OPTIONS") throw new ServerFoundationError("HTTP_METHOD_NOT_ALLOWED");
      const expectedRoute = request.method === "GET" ? MEMBERSHIP_ROUTE_KEY : MEMBERSHIP_OPTIONS_ROUTE_KEY;
      if (event.routeKey !== expectedRoute) throw new ServerFoundationError("HTTP_ROUTE_NOT_FOUND");
      const requestHeaders = headers(event.headers);
      corsHeaders = cors(requestHeaders, request.method, config.allowedOrigins);
      if (request.method === "OPTIONS") return response(204, requestId, {}, corsHeaders);
      if (!config.enabled) throw new ServerFoundationError(config.disabledErrorCode);
      if (event.body !== undefined && event.body !== null && event.body !== "") throw new ServerFoundationError("HTTP_EVENT_INVALID");
      if (event.queryStringParameters !== undefined && event.queryStringParameters !== null) throw new ServerFoundationError("HTTP_EVENT_INVALID");
      const result = await getCanonicalMembershipStatus({
        headers: requestHeaders,
        sessionSecret: await dependencies.getSessionSecret(),
        repository: dependencies.repository,
        quotaRepository: dependencies.quotaRepository,
        requireCanonicalMembership: config.requireCanonicalMembership,
      });
      return response(200, requestId, result, corsHeaders);
    } catch (error) {
      const safe = toSafeErrorResponse(error, requestId);
      writeSafeAuditLog({
        event: {
          requestId,
          event: config.auditEvent,
          outcome: safe.status >= 500 ? "error" : "denied",
          errorCode: safe.body.error.code,
        },
        sink: dependencies.auditSink,
      });
      return response(safe.status, requestId, safe.body, corsHeaders);
    }
  };
}
