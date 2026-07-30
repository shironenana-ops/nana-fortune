import { createHash } from "node:crypto";
import {
  FINCODE_WEBHOOK_MAX_BODY_BYTES,
  validateFincodeWebhookTransport,
} from "./webhookSchema";
import {
  FincodeWebhookError,
  type FincodeWebhookHeaders,
} from "./webhookTypes";

export type ApiGatewayV2WebhookEvent = {
  version?: unknown;
  headers?: unknown;
  body?: unknown;
  isBase64Encoded?: unknown;
  requestContext?: {
    requestId?: unknown;
    http?: { method?: unknown };
  } | null;
};

export type AdaptedFincodeWebhookRequest = {
  method: "POST";
  contentType: string;
  headers: FincodeWebhookHeaders;
  rawBody: string;
  correlationId: string;
};

export type FincodeWebhookHttpResponse = {
  statusCode: 200 | 400 | 401 | 409 | 503;
  headers: { "content-type": "application/json" };
  body: string;
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHeaders(value: unknown): FincodeWebhookHeaders {
  if (!plainRecord(value)) throw new FincodeWebhookError("WEBHOOK_HTTP_EVENT_INVALID");
  const headers: FincodeWebhookHeaders = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!name || /[\r\n\0]/u.test(name) || typeof headerValue !== "string") {
      throw new FincodeWebhookError("WEBHOOK_HTTP_EVENT_INVALID");
    }
    headers[name] = headerValue;
  }
  return headers;
}

function singleHeader(headers: FincodeWebhookHeaders, expectedName: string): string | undefined {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === expectedName)
    .map(([, value]) => value);
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].includes(",")) return undefined;
  return values[0];
}

function strictBase64(value: string): string {
  if (!value || !BASE64.test(value)) throw new FincodeWebhookError("WEBHOOK_BODY_ENCODING_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.byteLength > FINCODE_WEBHOOK_MAX_BODY_BYTES) {
    throw new FincodeWebhookError(
      bytes.byteLength > FINCODE_WEBHOOK_MAX_BODY_BYTES
        ? "WEBHOOK_BODY_TOO_LARGE"
        : "WEBHOOK_BODY_ENCODING_INVALID",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FincodeWebhookError("WEBHOOK_BODY_ENCODING_INVALID");
  }
}

function correlationId(value: unknown): string {
  if (typeof value === "string" && SAFE_REQUEST_ID.test(value)) return value;
  return createHash("sha256").update("invalid-fincode-webhook-request", "utf8").digest("hex");
}

export function adaptFincodeWebhookHttpEvent(event: unknown): AdaptedFincodeWebhookRequest {
  if (!plainRecord(event) || event.version !== "2.0") {
    throw new FincodeWebhookError("WEBHOOK_HTTP_EVENT_INVALID");
  }
  const typed = event as ApiGatewayV2WebhookEvent;
  const headers = normalizeHeaders(typed.headers);
  const method = typed.requestContext?.http?.method;
  const contentType = singleHeader(headers, "content-type");
  if (!contentType) throw new FincodeWebhookError("WEBHOOK_CONTENT_TYPE_INVALID");
  if (typeof typed.body !== "string") throw new FincodeWebhookError("WEBHOOK_JSON_INVALID");
  if (typed.isBase64Encoded !== true && typed.isBase64Encoded !== false) {
    throw new FincodeWebhookError("WEBHOOK_HTTP_EVENT_INVALID");
  }
  const rawBody = typed.isBase64Encoded ? strictBase64(typed.body) : typed.body;
  validateFincodeWebhookTransport({ method, contentType, rawBody });
  return {
    method: "POST",
    contentType,
    headers,
    rawBody,
    correlationId: correlationId(typed.requestContext?.requestId),
  };
}

function json(statusCode: FincodeWebhookHttpResponse["statusCode"], body: object): FincodeWebhookHttpResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function fincodeWebhookAcknowledgedResponse(): FincodeWebhookHttpResponse {
  return json(200, { receive: "0" });
}

export function fincodeWebhookRetryResponse(): FincodeWebhookHttpResponse {
  return json(503, { receive: "1" });
}

export function fincodeWebhookRejectedResponse(statusCode: 400 | 401 | 409): FincodeWebhookHttpResponse {
  return json(statusCode, { receive: "1", code: "FINCODE_WEBHOOK_REJECTED" });
}
