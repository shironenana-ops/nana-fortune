import { createDynamoUserRepository } from "../users/dynamoUserRepository";
import { createStagingMembershipStatusHandler, LOCAL_STAGING_ORIGINS } from "./membershipStatusHandler";
import { assertStagingRuntimeSecretArn, assertStagingTableName, loadStagingSessionSecret } from "./runtimeSecret";
import type { ApiGatewayV2Event } from "../readingApi/readingApiTypes";

function readEnabled(value: unknown): boolean {
  if (value !== "true" && value !== "false") throw new Error("staging membership flag is not configured");
  return value === "true";
}

function readOrigins(value: unknown): ReadonlySet<string> {
  if (typeof value !== "string") throw new Error("staging origins are not configured");
  const origins = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
  if (origins.size !== LOCAL_STAGING_ORIGINS.size || [...LOCAL_STAGING_ORIGINS].some((origin) => !origins.has(origin))) {
    throw new Error("staging origins are not configured");
  }
  return origins;
}

export async function handler(event: ApiGatewayV2Event) {
  const env = process.env;
  if (env.STAGING_ENVIRONMENT !== "staging" || env.AWS_REGION !== "ap-northeast-1") {
    throw new Error("staging boundary is not configured");
  }
  const enabled = readEnabled(env.STAGING_MEMBERSHIP_STATUS_ENABLED);
  const secretArn = assertStagingRuntimeSecretArn(env.RUNTIME_SECRETS_ARN);
  assertStagingTableName(env.USERS_TABLE_NAME);
  const app = createStagingMembershipStatusHandler(
    { enabled, allowedOrigins: readOrigins(env.ALLOWED_ORIGINS) },
    {
      repository: createDynamoUserRepository(env),
      getSessionSecret: () => loadStagingSessionSecret({ secretArn }),
    },
  );
  return app(event);
}
