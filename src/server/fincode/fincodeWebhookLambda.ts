import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createFincodeWebhookAwsAdapters, DynamoFincodeOneTimeVoicePurchaseStore, loadStagingFincodeTestProviderConfig, readFincodeWebhookAwsConfig } from "./aws";
import { fincodeWebhookRetryResponse, type FincodeWebhookHttpResponse } from "./webhookHttpAdapter";
import { orchestrateFincodeWebhook } from "./webhookOrchestrator";
import type { FincodeSubscriptionPeriodSource } from "./subscriptionPeriodSource";
import { ProvisionalFincodeTestAsiaTokyoPeriodSource } from "./provisionalFincodeTestPeriodSource";
import { orchestrateFincodeOneTimeVoiceWebhook } from "./fincodeOneTimeVoiceWebhook";
import { adaptFincodeWebhookHttpEvent } from "./webhookHttpAdapter";

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

    let providerConfig;
    if (config.provisionalTestPeriodSourceEnabled || config.oneTimeVoiceEnabled) {
      try { providerConfig = await beforeDeadline(loadStagingFincodeTestProviderConfig(secretsManager, config.testProviderSecretId!), Math.max(1, config.internalDeadlineMs - (clock() - started))); }
      catch { return fincodeWebhookRetryResponse(); }
    }
    const remaining = Math.max(1, config.internalDeadlineMs - (clock() - started));
    try {
      if (config.oneTimeVoiceEnabled && providerConfig) {
        let eventType: unknown;
        try { eventType = JSON.parse(adaptFincodeWebhookHttpEvent(event).rawBody)?.event; } catch { eventType = undefined; }
        if (typeof eventType === "string" && eventType.startsWith("payments.card.")) {
          const diagnosticSink = dependencies.auditSink ?? console.log;
          const store = new DynamoFincodeOneTimeVoicePurchaseStore(
            dynamodb,
            { purchaseTableName: config.oneTimeVoicePurchaseTableName!, usersTableName: config.usersTableName, environment: "staging" },
            (resultCode) => diagnosticSink(JSON.stringify({ event: "fincode_voice_single", result_code: resultCode })),
          );
          return await beforeDeadline(orchestrateFincodeOneTimeVoiceWebhook({ event, expectedSignature, provider: providerConfig, intents: store, grants: store, auditSink: dependencies.auditSink, now: dependencies.now }), remaining);
        }
      }
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
        retentionPolicy: { ttlSeconds: config.ledgerRetentionDays * 86_400, minimumTtlSeconds: 30 * 86_400, maximumTtlSeconds: 730 * 86_400 },
        ledger: adapters.ledger,
        customers: adapters.customers,
        atomicCompletion: adapters.atomicCompletion,
        completionPlanFactory: adapters.completionPlanFactory,
        planResolver: adapters.planResolver,
        periodSource: config.periodSourceEnabled
          ? dependencies.periodSource ?? (config.provisionalTestPeriodSourceEnabled && providerConfig ? new ProvisionalFincodeTestAsiaTokyoPeriodSource(providerConfig) : unavailablePeriodSource)
          : unavailablePeriodSource,
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
