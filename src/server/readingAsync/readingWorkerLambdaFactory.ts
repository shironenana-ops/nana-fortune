import { runShironeEngineOnServer } from "../shironeEngineServer";
import { readBedrockRendererConfig, BedrockReadingProseRenderer } from "../reading/rendering/bedrockReadingProseRenderer";
import { renderReadingWithFallback } from "../reading/rendering/renderReadingWithFallback";
import { systemClock } from "../reading/serverReadingDate";
import { readReadingPersistenceConfig } from "../readingPersistence/persistenceConfig";
import { readDeepQuotaConfig } from "../readingPersistence/deepQuota";
import { readReadingRateLimitConfig } from "../readingRateLimit/rateLimitPolicy";
import { createDynamoAsyncReadingPersistence } from "./dynamoAsyncReadingPersistence";
import { readReadingAsyncConfig } from "./readingAsyncConfig";
import { createReadingWorkerHandler, type SqsEvent } from "./readingWorkerService";
import type { PaidReadingMode } from "./readingJobTypes";

export function createReadingWorkerLambda(mode: PaidReadingMode) {
  return async (event: SqsEvent) => {
    const env = process.env;
    const asyncConfig = readReadingAsyncConfig(env);
    const persistenceConfig = {
      ...readReadingPersistenceConfig(env),
      ...asyncConfig,
      rateLimit: readReadingRateLimitConfig(env, env.READING_IDEMPOTENCY_HASH_SECRET),
      ...(mode === "deep" ? { deepQuota: readDeepQuotaConfig(env) } : {}),
    };
    const bedrockConfig = readBedrockRendererConfig(env);
    const renderer = bedrockConfig.enabled ? new BedrockReadingProseRenderer(bedrockConfig) : undefined;
    return createReadingWorkerHandler(mode, {
      persistence: createDynamoAsyncReadingPersistence(persistenceConfig),
      engineRunner: runShironeEngineOnServer,
      renderReading: (params) => renderReadingWithFallback({ ...params, enabled: bedrockConfig.enabled, renderer }),
      auditHashSecret: env.AUDIT_HASH_SECRET,
      clock: systemClock,
      orphanGraceSeconds: asyncConfig.orphanGraceSeconds,
    })(event);
  };
}
