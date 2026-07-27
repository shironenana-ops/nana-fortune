import { parseAllowedOrigins } from "../http/cors";
import { createRequestId } from "../http/requestId";
import { toSafeErrorResponse } from "../http/errors";
import type { ApiGatewayV2Event } from "../readingApi/readingApiTypes";
import { createDynamoReadingStatusRepository } from "./dynamoReadingStatusRepository";
import { readReadingStatusConfig, readingStatusApiEnabled } from "./readingStatusConfig";
import { createReadingStatusHandler } from "./readingStatusHandler";

export async function handler(event: ApiGatewayV2Event) {
  const env = process.env;
  try {
    const enabled = readingStatusApiEnabled(env.READING_STATUS_API_ENABLED);
    const app = createReadingStatusHandler({ enabled, allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS) }, {
      repository: createDynamoReadingStatusRepository(readReadingStatusConfig(env)),
      sessionSecret: env.SESSION_TOKEN_SECRET,
      auditHashSecret: env.AUDIT_HASH_SECRET,
    });
    return await app(event);
  } catch (error) {
    const context = event && typeof event.requestContext === "object" && event.requestContext !== null ? event.requestContext as Record<string, unknown> : {};
    const requestId = createRequestId(context.requestId);
    const safe = toSafeErrorResponse(error, requestId);
    return { statusCode: safe.status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId }, body: JSON.stringify(safe.body), isBase64Encoded: false as const };
  }
}
