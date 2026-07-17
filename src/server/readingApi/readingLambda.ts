import { createReadingApiHandler, readingApiEnabled } from "./readingApiHandler";
import { parseAllowedOrigins } from "../http/cors";
import { createRequestId } from "../http/requestId";
import { toSafeErrorResponse } from "../http/errors";
import { createDynamoUserRepository } from "../users/dynamoUserRepository";
import { runShironeEngineOnServer } from "../shironeEngineServer";
import { systemClock } from "../reading/serverReadingDate";
import { BedrockReadingProseRenderer, readBedrockRendererConfig } from "../reading/rendering/bedrockReadingProseRenderer";
import { renderReadingWithFallback } from "../reading/rendering/renderReadingWithFallback";
import type { ApiGatewayV2Event } from "./readingApiTypes";
import { createDynamoReadingPersistence } from "../readingPersistence/dynamoReadingPersistence";
import { readReadingPersistenceConfig } from "../readingPersistence/persistenceConfig";

export async function handler(event: ApiGatewayV2Event) {
  const env = process.env;
  try {
    const persistenceConfig = readReadingPersistenceConfig(env);
    const app = createReadingApiHandler({
      enabled: readingApiEnabled(env.READING_GENERATE_API_ENABLED),
      allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    }, {
      repository: {
        findMembershipByUserId: (userId) => createDynamoUserRepository(env).findMembershipByUserId(userId),
      },
      clock: systemClock,
      sessionSecret: env.SESSION_TOKEN_SECRET,
      auditHashSecret: env.AUDIT_HASH_SECRET,
      persistence: createDynamoReadingPersistence(persistenceConfig),
      idempotencyHashSecret: persistenceConfig.hashSecret,
      deepEnabled: env.READING_DEEP_GENERATE_API_ENABLED === "true",
      engineRunner: runShironeEngineOnServer,
      renderReading: (params) => {
        try {
          const bedrockConfig = readBedrockRendererConfig(env);
          const renderer = bedrockConfig.enabled ? new BedrockReadingProseRenderer(bedrockConfig) : undefined;
          return renderReadingWithFallback({ ...params, enabled: bedrockConfig.enabled, renderer });
        } catch {
          return Promise.resolve({
            ...params.reading,
            rendering: {
              status: "fallback" as const,
              provider: "canonical" as const,
              fallbackReason: "configuration_error" as const,
            },
          });
        }
      },
    });
    return await app(event);
  } catch (error) {
    const context = event && typeof event.requestContext === "object" && event.requestContext !== null
      ? event.requestContext as Record<string, unknown>
      : {};
    const requestId = createRequestId(context.requestId);
    const safe = toSafeErrorResponse(error, requestId);
    return {
      statusCode: safe.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId },
      body: JSON.stringify(safe.body),
      isBase64Encoded: false as const,
    };
  }
}
