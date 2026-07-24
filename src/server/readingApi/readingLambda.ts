import { createReadingApiHandler, readingApiEnabled } from "./readingApiHandler";
import { parseAllowedOrigins } from "../http/cors";
import { createRequestId } from "../http/requestId";
import { toSafeErrorResponse } from "../http/errors";
import { createDynamoUserRepository } from "../users/dynamoUserRepository";
import { runShironeEngineOnServer } from "../shironeEngineServer";
import { systemClock } from "../reading/serverReadingDate";
import type { ApiGatewayV2Event } from "./readingApiTypes";
import { createDynamoReadingPersistence } from "../readingPersistence/dynamoReadingPersistence";
import { readReadingPersistenceConfig } from "../readingPersistence/persistenceConfig";
import { readDeepQuotaConfig } from "../readingPersistence/deepQuota";
import { readReadingRateLimitConfig } from "../readingRateLimit/rateLimitPolicy";
import { readingAsyncPaidEnabled, readReadingAsyncConfig } from "../readingAsync/readingAsyncConfig";
import { createSqsReadingJobQueue, readReadingQueueConfig } from "../readingAsync/sqsReadingJobQueue";
import { createDynamoAsyncReadingPersistence } from "../readingAsync/dynamoAsyncReadingPersistence";
import { createReadingAsyncAcceptance } from "../readingAsync/readingAsyncAcceptance";

export async function handler(event: ApiGatewayV2Event) {
  const env = process.env;
  try {
    const enabled = readingApiEnabled(env.READING_GENERATE_API_ENABLED);
    const asyncPaidEnabled = readingAsyncPaidEnabled(env.READING_ASYNC_PAID_ENABLED);
    const basePersistenceConfig = readReadingPersistenceConfig(env);
    const rateLimit = enabled || asyncPaidEnabled
      ? readReadingRateLimitConfig(env, env.READING_IDEMPOTENCY_HASH_SECRET)
      : undefined;
    const persistenceConfig = {
      ...basePersistenceConfig,
      ...(rateLimit ? { rateLimit } : {}),
    };
    const asyncPersistenceConfig = asyncPaidEnabled
      ? {
          ...basePersistenceConfig,
          ...readReadingAsyncConfig(env),
          rateLimit: rateLimit!,
          deepQuota: readDeepQuotaConfig(env),
        }
      : undefined;
    const asyncAcceptance = asyncPaidEnabled
      ? createReadingAsyncAcceptance({
          queue: createSqsReadingJobQueue(readReadingQueueConfig(env)),
          persistence: createDynamoAsyncReadingPersistence(asyncPersistenceConfig!),
          auditHashSecret: env.AUDIT_HASH_SECRET ?? "",
        })
      : undefined;
    const app = createReadingApiHandler({
      enabled,
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
      deepEnabled: false,
      asyncPaidEnabled,
      asyncAcceptance,
      engineRunner: runShironeEngineOnServer,
      renderReading: async () => { throw new Error("paid rendering is worker-only"); },
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
