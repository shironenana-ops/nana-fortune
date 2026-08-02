import { FincodeTestError } from "./fincodeTestErrors";

export const FINCODE_TEST_API_ORIGIN = "https://api.test.fincode.jp";
export const FINCODE_TEST_HTTP_TIMEOUT_MS = 10_000;
export const FINCODE_TEST_MAX_RESPONSE_BYTES = 65_536;

export type FincodeTestPaymentConfig = {
  enabled: true;
  apiOrigin: typeof FINCODE_TEST_API_ORIGIN;
  secretKey: string;
  shopId: string;
};

export type FincodeTestEnvironment = Record<string, unknown>;

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

export function assertFincodeTestOnly(apiBase: unknown): typeof FINCODE_TEST_API_ORIGIN {
  const candidate = apiBase === undefined || apiBase === "" ? FINCODE_TEST_API_ORIGIN : apiBase;
  if (candidate !== FINCODE_TEST_API_ORIGIN) {
    throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
  }

  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.test.fincode.jp" || parsed.origin !== FINCODE_TEST_API_ORIGIN) {
    throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
  }
  return FINCODE_TEST_API_ORIGIN;
}

export function loadFincodeTestPaymentConfig(env: FincodeTestEnvironment): FincodeTestPaymentConfig {
  if (env.FINCODE_TEST_PAYMENT_ENABLED !== "true") {
    throw new FincodeTestError("FINCODE_TEST_DISABLED");
  }

  const apiOrigin = assertFincodeTestOnly(env.FINCODE_TEST_API_BASE);
  const secretKey = requiredString(env.FINCODE_TEST_SECRET_KEY);
  const shopId = requiredString(env.FINCODE_TEST_SHOP_ID);

  if (!secretKey || !secretKey.startsWith("m_test_") || !shopId) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }

  return { enabled: true, apiOrigin, secretKey, shopId };
}

export function isFincodeTestPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("p_test_") && value.length > "p_test_".length;
}
