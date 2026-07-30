import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createFincodeWebhookAwsAdapters, readFincodeWebhookAwsConfig } from "./aws";
import { fincodeWebhookRetryResponse, type FincodeWebhookHttpResponse } from "./webhookHttpAdapter";
import { orchestrateFincodeWebhook } from "./webhookOrchestrator";
import type { FincodeSubscriptionPeriodSource } from "./subscriptionPeriodSource";

type Env = Record<string, string | undefined>;
type Dependencies = {
  env?: Env;
  dynamodb?: { send(command: unknown): Promise<unknown> };
  secretsManager?: { send(command: unknown): Promise<unknown> };
  periodSource?: FincodeSubscriptionPeriodSource;
  auditSink?: (line: string) => void;
  now?: () => number;
};

const unavailablePeriodSource: FincodeSubscriptionPeriodSource = {
  async resolve() { return { status: "NOT_AVAILABLE" }; },
};

async function beforeDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createFincodeWebhookLambda(dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  return async (event: unknown): Promise<FincodeWebhookHttpResponse> => {
    const clock = dependencies.now ?? Date.now;
    const started = clock();
    let config;
    try { config = readFincodeWebhookAwsConfig(env); }
    catch { return fincodeWebhookRetryResponse(); }
    if (!config.enabled) return fincodeWebhookRetryResponse();

    const dynamodb = dependencies.dynamodb ?? new DynamoDBClient({ maxAttempts: 1 });
    const secretsManager = dependencies.secretsManager ?? new SecretsManagerClient({ maxAttempts: 1 });
    const adapters = createFincodeWebhookAwsAdapters(config, { dynamodb, secretsManager });
    let expectedSignature: string;
    try { expectedSignature = await beforeDeadline(adapters.signature.getExpectedSignature(), Math.max(1, config.internalDeadlineMs - (clock() - started))); }
    catch { return fincodeWebhookRetryResponse(); }

    const remaining = Math.max(1, config.internalDeadlineMs - (clock() - started));
    try {
      return await beforeDeadline(orchestrateFincodeWebhook(event, {
        boundary: {
          enabled: true,
          environment: config.environment,
          customerReferencePrefix: config.customerReferencePrefix,
          allowedShopRefs: new Set(),
          allowedShopDigests: config.allowedShopDigests,
          allowedPlanRefs: new Set(config.planMapping.keys()),
        },
        expectedSignature,
        retentionPolicy: { retentionDays: config.ledgerRetentionDays, nowEpochSeconds: Math.floor(clock() / 1000) },
        ledger: adapters.ledger,
        customers: adapters.customers,
        atomicCompletion: adapters.atomicCompletion,
        completionPlanFactory: adapters.completionPlanFactory,
        planResolver: adapters.planResolver,
        periodSource: config.periodSourceEnabled ? dependencies.periodSource : unavailablePeriodSource,
        auditSink: dependencies.auditSink,
        now: dependencies.now,
      }), remaining);
    } catch {
      return fincodeWebhookRetryResponse();
    } finally {
      expectedSignature = "";
    }
  };
}

export const handler = createFincodeWebhookLambda();
