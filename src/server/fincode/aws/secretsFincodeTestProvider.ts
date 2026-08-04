import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { ProvisionalFincodeTestProviderConfig } from "../provisionalFincodeTestPeriodSource";

type Sender = { send(command: unknown): Promise<unknown> };

export async function loadStagingFincodeTestProviderConfig(client: Sender, secretId: string): Promise<ProvisionalFincodeTestProviderConfig> {
  if (!secretId || /[\r\n\0]/u.test(secretId)) throw new Error("FINCODE_TEST_PROVIDER_CONFIG_INVALID");
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId })) as { SecretString?: unknown };
  if (typeof response.SecretString !== "string") throw new Error("FINCODE_TEST_PROVIDER_CONFIG_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(response.SecretString); } catch { throw new Error("FINCODE_TEST_PROVIDER_CONFIG_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FINCODE_TEST_PROVIDER_CONFIG_INVALID");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "fincode_test_secret_key,fincode_test_shop_id" ||
      typeof record.fincode_test_secret_key !== "string" || !record.fincode_test_secret_key.startsWith("m_test_") ||
      typeof record.fincode_test_shop_id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/u.test(record.fincode_test_shop_id)) {
    throw new Error("FINCODE_TEST_PROVIDER_CONFIG_INVALID");
  }
  return { apiOrigin: "https://api.test.fincode.jp", secretKey: record.fincode_test_secret_key, shopId: record.fincode_test_shop_id };
}
