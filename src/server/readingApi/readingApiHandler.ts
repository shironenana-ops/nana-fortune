import { createRequestId } from "../http/requestId";
import { evaluateCors } from "../http/cors";
import { ServerFoundationError, toSafeErrorResponse } from "../http/errors";
import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { executeReadingApi } from "./readingApiService";
import {
  READING_API_PATH,
  READING_BODY_MAX_BYTES,
  READING_ENCODED_BODY_MAX_BYTES,
  type ApiGatewayV2Event,
  type LambdaHttpResponse,
  type ReadingApiDependencies,
} from "./readingApiTypes";

type HandlerConfig = {
  enabled: boolean;
  allowedOrigins: ReadonlySet<string>;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestContext(event: ApiGatewayV2Event): { method: string; requestId?: string } {
  if (event.version !== "2.0" || !record(event.requestContext)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const http = event.requestContext.http;
  if (!record(http) || typeof http.method !== "string") throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const requestId = typeof event.requestContext.requestId === "string" ? event.requestContext.requestId : undefined;
  return { method: http.method.toUpperCase(), requestId };
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!record(value)) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  const result: Record<string, string> = {};
  const names = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!name || names.has(name) || /[\r\n:]/u.test(rawName) || typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) {
      throw new ServerFoundationError("HTTP_EVENT_INVALID");
    }
    names.add(name);
    result[name] = rawValue;
  }
  return result;
}

function requireSingleValue(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (value !== undefined && value.includes(",")) throw new ServerFoundationError("HTTP_EVENT_INVALID");
  return value;
}

function contentTypeAllowed(value: string | undefined): boolean {
  return typeof value === "string" && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

function decodeBody(event: ApiGatewayV2Event): unknown {
  if (typeof event.body !== "string" || event.body.length === 0) throw new ServerFoundationError("REQUEST_BODY_INVALID");
  let text: string;
  if (event.isBase64Encoded === true) {
    if (Buffer.byteLength(event.body, "utf8") > READING_ENCODED_BODY_MAX_BYTES) throw new ServerFoundationError("REQUEST_BODY_TOO_LARGE");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(event.body)) throw new ServerFoundationError("REQUEST_BODY_INVALID");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(event.body, "base64"));
    } catch {
      throw new ServerFoundationError("REQUEST_BODY_INVALID");
    }
  } else if (event.isBase64Encoded === false || event.isBase64Encoded === undefined) {
    text = event.body;
  } else {
    throw new ServerFoundationError("HTTP_EVENT_INVALID");
  }
  if (Buffer.byteLength(text, "utf8") > READING_BODY_MAX_BYTES) throw new ServerFoundationError("REQUEST_BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ServerFoundationError("REQUEST_BODY_INVALID"); }
  if (!record(parsed)) throw new ServerFoundationError("REQUEST_BODY_INVALID");
  return parsed;
}

function response(statusCode: number, requestId: string, body: unknown, cors: Record<string, string> = {}, extra: Record<string, string> = {}): LambdaHttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId, ...cors, ...extra },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

export function createReadingApiHandler(config: HandlerConfig, dependencies: ReadingApiDependencies) {
  return async (event: ApiGatewayV2Event): Promise<LambdaHttpResponse> => {
    let requestId = createRequestId();
    let corsHeaders: Record<string, string> = {};
    try {
      const context = requestContext(event);
      requestId = createRequestId(context.requestId);
      if (event.rawPath !== READING_API_PATH) throw new ServerFoundationError("HTTP_ROUTE_NOT_FOUND");
      const headers = normalizeHeaders(event.headers);
      if (context.method !== "POST" && context.method !== "OPTIONS") {
        throw new ServerFoundationError("HTTP_METHOD_NOT_ALLOWED");
      }
      const origin = requireSingleValue(headers, "origin");
      const cors = evaluateCors({
        origin,
        allowedOrigins: config.allowedOrigins,
        method: context.method,
        requestedHeaders: context.method === "OPTIONS" ? headers["access-control-request-headers"] : undefined,
      });
      corsHeaders = Object.fromEntries(
        Object.entries(cors.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      if (context.method === "OPTIONS") return response(204, requestId, {}, corsHeaders);
      if (!config.enabled) throw new ServerFoundationError("READING_API_DISABLED");
      if (!contentTypeAllowed(requireSingleValue(headers, "content-type"))) throw new ServerFoundationError("CONTENT_TYPE_NOT_SUPPORTED");
      // Security-sensitive headers cannot be comma-joined or carry multiple values.
      requireSingleValue(headers, "authorization");
      requireSingleValue(headers, "idempotency-key");
      const rawBody = decodeBody(event);
      const result = await executeReadingApi({ requestId, headers, rawBody }, dependencies);
      return response(200, requestId, result, corsHeaders);
    } catch (error) {
      const safe = toSafeErrorResponse(error, requestId);
      const code = safe.body.error.code;
      writeSafeAuditLog({
        event: { requestId, event: "reading_http_rejected", outcome: code === "INTERNAL_ERROR" ? "error" : "denied", errorCode: code },
        sink: dependencies.auditSink,
      });
      const extra: Record<string, string> = code === "HTTP_METHOD_NOT_ALLOWED" ? { Allow: "POST, OPTIONS" } : {};
      if (safe.retryAfter) extra["Retry-After"] = String(safe.retryAfter);
      return response(safe.status, requestId, safe.body, corsHeaders, extra);
    }
  };
}

export function readingApiEnabled(value: string | undefined): boolean {
  return value === "true";
}
