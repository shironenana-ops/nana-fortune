import type { ApiGatewayV2Event } from "../readingApi/readingApiTypes";
import { createDynamoMembershipQuotaRepository } from "../users/dynamoMembershipQuotaRepository";
import { createDynamoUserRepository } from "../users/dynamoUserRepository";
import { createMembershipStatusHandler } from "./membershipStatusHandler";

const PRODUCTION_ORIGINS = new Set([
  "https://www.nana-fortune.com",
  "https://nana-fortune.com",
]);

function enabled(value: unknown): boolean {
  if (value !== "true" && value !== "false") throw new Error("production membership flag is not configured");
  return value === "true";
}

function origins(value: unknown): ReadonlySet<string> {
  if (typeof value !== "string") throw new Error("production membership origins are not configured");
  const result = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
  if (result.size !== PRODUCTION_ORIGINS.size || [...PRODUCTION_ORIGINS].some((origin) => !result.has(origin))) {
    throw new Error("production membership origins are not configured");
  }
  return result;
}

function assertProductionEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.RUNTIME_ENVIRONMENT !== "production" || env.AWS_REGION !== "ap-northeast-1" ||
      !env.USERS_TABLE_NAME || /staging/iu.test(env.USERS_TABLE_NAME) ||
      !env.SESSION_TOKEN_SECRET || env.SESSION_TOKEN_SECRET.length < 32) {
    throw new Error("production membership boundary is not configured");
  }
}

export async function handler(event: ApiGatewayV2Event) {
  const env = process.env;
  assertProductionEnvironment(env);
  return createMembershipStatusHandler({
    enabled: enabled(env.MEMBERSHIP_STATUS_API_ENABLED),
    allowedOrigins: origins(env.ALLOWED_ORIGINS),
    disabledErrorCode: "MEMBERSHIP_STATUS_DISABLED",
    auditEvent: "membership_status_rejected",
    requireCanonicalMembership: true,
  }, {
    repository: createDynamoUserRepository(env),
    quotaRepository: createDynamoMembershipQuotaRepository(env),
    getSessionSecret: async () => env.SESSION_TOKEN_SECRET!,
  })(event);
}
