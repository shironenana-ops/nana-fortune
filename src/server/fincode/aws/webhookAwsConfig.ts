import type { FincodeEnvironment } from "../webhookTypes";
import { FINCODE_MEMBERSHIP_SCHEMA_VERSION } from "../membershipSchema";
import { FincodeWebhookAwsError } from "./webhookAwsErrors";

export { FINCODE_MEMBERSHIP_SCHEMA_VERSION };

export type FincodeWebhookAwsConfig = {
  enabled: boolean;
  environment: FincodeEnvironment;
  ledgerTableName: string;
  customerMappingTableName: string;
  usersTableName: string;
  deepQuotaTableName: string;
  lightQuotaTableName?: string;
  signatureSecretId: string;
  signatureSecretEnvironment: FincodeEnvironment;
  ledgerRetentionDays: number;
  secretCacheTtlSeconds: number;
  allowedShopDigests: ReadonlySet<string>;
  planMapping: ReadonlyMap<string, "light" | "premium">;
  usersMembershipSchemaVersion?: typeof FINCODE_MEMBERSHIP_SCHEMA_VERSION;
  mutationAvailable: boolean;
  periodSourceEnabled: boolean;
  provisionalTestPeriodSourceEnabled: boolean;
  oneTimeVoiceEnabled: boolean;
  testProviderSecretId?: string;
  oneTimeVoicePurchaseTableName?: string;
  customerReferencePrefix: string;
  internalDeadlineMs: number;
};

const fail = (): never => { throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_AWS_CONFIG_INVALID"); };
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/u;
const PROVIDER_REF = /^[A-Za-z0-9_-]{1,25}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n\0]/u.test(value)) return fail();
  return value;
}

function table(env: Record<string, string | undefined>, key: string): string {
  const value = required(env, key);
  return TABLE_NAME.test(value) ? value : fail();
}

function optionalTable(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  if (value.trim() !== value || !TABLE_NAME.test(value) || /[\r\n\0]/u.test(value)) return fail();
  return value;
}

function integer(env: Record<string, string | undefined>, key: string, min: number, max: number): number {
  const value = required(env, key);
  if (!/^\d+$/u.test(value)) return fail();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fail();
}

function environment(value: string | undefined): FincodeEnvironment {
  return value === "staging" || value === "production" ? value : fail();
}

function exactBoolean(value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fail();
}

function digestSet(raw: string): ReadonlySet<string> {
  const values = raw.split(",");
  if (values.length === 0 || values.some((value) => !HEX_DIGEST.test(value)) || new Set(values).size !== values.length) return fail();
  return new Set(values);
}

function planMapping(raw: string): ReadonlyMap<string, "light" | "premium"> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, plan]) => !PROVIDER_REF.test(key) || (plan !== "light" && plan !== "premium"))) return fail();
  return new Map(entries as Array<[string, "light" | "premium"]>);
}

export function readFincodeWebhookAwsConfig(
  env: Record<string, string | undefined> = process.env,
): FincodeWebhookAwsConfig {
  const resolvedEnvironment = environment(env.FINCODE_WEBHOOK_ENVIRONMENT);
  const secretEnvironment = environment(env.FINCODE_WEBHOOK_SIGNATURE_SECRET_ENVIRONMENT);
  if (secretEnvironment !== resolvedEnvironment) return fail();
  const lightQuotaTableName = optionalTable(env, "FINCODE_LIGHT_QUOTA_TABLE") ?? optionalTable(env, "FINCODE_MEMBERSHIP_QUOTA_TABLE");
  const legacyLightQuotaTableName = optionalTable(env, "FINCODE_MEMBERSHIP_QUOTA_TABLE");
  if (lightQuotaTableName && legacyLightQuotaTableName && lightQuotaTableName !== legacyLightQuotaTableName) return fail();
  const usersMembershipSchemaVersion = env.FINCODE_USERS_MEMBERSHIP_SCHEMA_VERSION;
  if (usersMembershipSchemaVersion !== undefined && usersMembershipSchemaVersion !== FINCODE_MEMBERSHIP_SCHEMA_VERSION) return fail();
  const enabled = exactBoolean(env.FINCODE_WEBHOOK_ENABLED);
  const periodSourceEnabled = exactBoolean(env.FINCODE_PERIOD_SOURCE_ENABLED);
  const provisionalTestPeriodSourceEnabled = exactBoolean(env.FINCODE_PROVISIONAL_TEST_PERIOD_SOURCE_ENABLED ?? "false");
  const oneTimeVoiceEnabled = exactBoolean(env.FINCODE_ONE_TIME_VOICE_WEBHOOK_ENABLED ?? "false");
  if ((provisionalTestPeriodSourceEnabled || oneTimeVoiceEnabled) && resolvedEnvironment !== "staging") return fail();
  const testProviderSecretId = env.FINCODE_TEST_PROVIDER_SECRET_ID ? required(env, "FINCODE_TEST_PROVIDER_SECRET_ID") : undefined;
  const oneTimeVoicePurchaseTableName = optionalTable(env, "FINCODE_ONE_TIME_VOICE_PURCHASE_TABLE");
  if ((provisionalTestPeriodSourceEnabled || oneTimeVoiceEnabled) && !testProviderSecretId) return fail();
  if (oneTimeVoiceEnabled && !oneTimeVoicePurchaseTableName) return fail();
  return {
    enabled,
    environment: resolvedEnvironment,
    ledgerTableName: table(env, "FINCODE_WEBHOOK_LEDGER_TABLE"),
    customerMappingTableName: table(env, "FINCODE_CUSTOMER_MAPPING_TABLE"),
    usersTableName: table(env, "USERS_TABLE_NAME"),
    deepQuotaTableName: table(env, "READING_DEEP_QUOTA_TABLE_NAME"),
    lightQuotaTableName,
    signatureSecretId: required(env, "FINCODE_WEBHOOK_SIGNATURE_SECRET_ID"),
    signatureSecretEnvironment: secretEnvironment,
    ledgerRetentionDays: integer(env, "FINCODE_WEBHOOK_LEDGER_RETENTION_DAYS", 30, 730),
    secretCacheTtlSeconds: integer(env, "FINCODE_WEBHOOK_SECRET_CACHE_TTL_SECONDS", 30, 3600),
    allowedShopDigests: digestSet(required(env, "FINCODE_WEBHOOK_ALLOWED_SHOP_DIGESTS")),
    planMapping: planMapping(required(env, "FINCODE_WEBHOOK_ALLOWED_PLAN_MAPPING")),
    ...(usersMembershipSchemaVersion ? { usersMembershipSchemaVersion } : {}),
    mutationAvailable: enabled && !!lightQuotaTableName && usersMembershipSchemaVersion === FINCODE_MEMBERSHIP_SCHEMA_VERSION,
    periodSourceEnabled,
    provisionalTestPeriodSourceEnabled,
    oneTimeVoiceEnabled,
    ...(testProviderSecretId ? { testProviderSecretId } : {}),
    ...(oneTimeVoicePurchaseTableName ? { oneTimeVoicePurchaseTableName } : {}),
    customerReferencePrefix: required(env, "FINCODE_CUSTOMER_REFERENCE_PREFIX"),
    // Keep a bounded safety margin below the 15 second Lambda/API integration timeout.
    internalDeadlineMs: integer(env, "FINCODE_WEBHOOK_INTERNAL_DEADLINE_MS", 500, 14_000),
  };
}
