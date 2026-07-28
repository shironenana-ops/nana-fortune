import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { ServerFoundationError, toSafeErrorResponse } from "../http/errors";
import { createRequestId } from "../http/requestId";
import type { ApiGatewayV2Event, LambdaHttpResponse } from "../readingApi/readingApiTypes";
import { executeReadingStatus } from "./readingStatusService";
import {
  READING_STATUS_API_OPTIONS_ROUTE_KEY,
  READING_STATUS_API_ROUTE_KEY,
  READING_STATUS_RETRY_AFTER_SECONDS,
  type ReadingStatusDependencies,
} from "./readingStatusTypes";

type HandlerConfig = { enabled: boolean; allowedOrigins: ReadonlySet<string> };
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function requestContext(event: ApiGatewayV2Event): { method: string; requestId?: string } {
  if (event.version !== "2.0" || !record(event.requestContext)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const http = event.requestContext.http;
  if (!record(http) || typeof http.method !== "string") throw new ServerFoundationError("HTTP_EVENT_INVALID");
  return { method: http.method.toUpperCase(), requestId: typeof event.requestContext.requestId === "string" ? event.requestContext.requestId : undefined };
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!record(value)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!name || name in headers || /[\r\n:]/u.test(rawName) || typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
    headers[name] = rawValue;
  }
  return headers;
}

function single(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name];
  if (value !== undefined && value.includes(",")) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  return value;
}

function validOrigin(value: string): boolean {
  if (!value || value === "null" || value === "*" || /[\r\n,]/u.test(value)) return false;
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.origin === value; }
  catch { return false; }
}

function corsHeaders(headers: Record<string, string>, method: string, allowedOrigins: ReadonlySet<string>): Record<string, string> {
  const origin = single(headers, "origin");
  if (origin === undefined) return { Vary: "Origin" };
  if (!validOrigin(origin) || !allowedOrigins.has(origin)) throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  if (method === "OPTIONS") {
    const requestedMethod = single(headers, "access-control-request-method");
    const requestedHeaders = single(headers, "access-control-request-headers") ?? "";
    if (requestedMethod !== "GET" || requestedHeaders.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).some((value) => value !== "authorization")) {
      throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
    }
  }
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "Authorization", "Access-Control-Max-Age": "600", Vary: "Origin" };
}

function readJobRef(event: ApiGatewayV2Event): string {
  if (!record(event.queryStringParameters)) throw new ServerFoundationError("READING_STATUS_REF_INVALID");
  const entries = Object.entries(event.queryStringParameters);
  if (entries.length !== 1 || entries[0][0] !== "job_ref" || typeof entries[0][1] !== "string") throw new ServerFoundationError("READING_STATUS_REF_INVALID");
  if (event.rawQueryString !== undefined) {
    if (typeof event.rawQueryString !== "string") throw new ServerFoundationError("HTTP_EVENT_INVALID");
    const rawEntries = [...new URLSearchParams(event.rawQueryString).entries()];
    if (rawEntries.length !== 1 || rawEntries[0][0] !== "job_ref" || rawEntries[0][1] !== entries[0][1]) throw new ServerFoundationError("READING_STATUS_REF_INVALID");
  }
  return entries[0][1];
}

function response(statusCode: number, requestId: string, body: unknown, cors: Record<string, string>, extra: Record<string, string> = {}): LambdaHttpResponse {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId, ...cors, ...extra }, body: statusCode === 204 ? "" : JSON.stringify(body), isBase64Encoded: false };
}

export function createReadingStatusHandler(config: HandlerConfig, dependencies: ReadingStatusDependencies) {
  return async (event: ApiGatewayV2Event): Promise<LambdaHttpResponse> => {
    let requestId = createRequestId();
    let cors: Record<string, string> = {};
    try {
      const context = requestContext(event);
      requestId = createRequestId(context.requestId);
      if (context.method !== "GET" && context.method !== "OPTIONS") throw new ServerFoundationError("HTTP_METHOD_NOT_ALLOWED");
      const expectedRouteKey = context.method === "GET" ? READING_STATUS_API_ROUTE_KEY : READING_STATUS_API_OPTIONS_ROUTE_KEY;
      if (event.routeKey !== expectedRouteKey) throw new ServerFoundationError("HTTP_ROUTE_NOT_FOUND");
      const headers = normalizeHeaders(event.headers);
      cors = corsHeaders(headers, context.method, config.allowedOrigins);
      if (context.method === "OPTIONS") return response(204, requestId, {}, cors);
      if (!config.enabled) throw new ServerFoundationError("READING_STATUS_API_DISABLED");
      if (event.body !== undefined && event.body !== null && event.body !== "") throw new ServerFoundationError("HTTP_EVENT_INVALID");
      single(headers, "authorization");
      const result = await executeReadingStatus({ requestId, headers, jobRef: readJobRef(event) }, dependencies);
      const pending = result.status === "QUEUED" || result.status === "IN_PROGRESS";
      return response(200, requestId, result, cors, pending ? { "Retry-After": String(READING_STATUS_RETRY_AFTER_SECONDS) } : {});
    } catch (error) {
      const safe = toSafeErrorResponse(error, requestId);
      writeSafeAuditLog({ event: { requestId, event: "reading_status_rejected", outcome: safe.status >= 500 ? "error" : "denied", errorCode: safe.body.error.code }, sink: dependencies.auditSink });
      const extra: Record<string, string> = safe.body.error.code === "HTTP_METHOD_NOT_ALLOWED" ? { Allow: "GET, OPTIONS" } : {};
      return response(safe.status, requestId, safe.body, cors, extra);
    }
  };
}
