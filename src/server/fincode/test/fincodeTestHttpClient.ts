import {
  FINCODE_TEST_MAX_RESPONSE_BYTES,
  FINCODE_TEST_HTTP_TIMEOUT_MS,
  type FincodeTestPaymentConfig,
} from "./fincodeTestConfig";
import { FincodeTestError } from "./fincodeTestErrors";

export type FincodeTestFetch = typeof fetch;

type RequestOptions = {
  method: "GET" | "POST";
  path: string;
  body?: object;
  idempotencyKey?: string;
};

async function readLimitedJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > FINCODE_TEST_MAX_RESPONSE_BYTES) {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FINCODE_TEST_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
  return parsed as Record<string, unknown>;
}

export async function requestFincodeTestJson(
  config: FincodeTestPaymentConfig,
  options: RequestOptions,
  fetchImpl: FincodeTestFetch = fetch,
  timeoutMs = FINCODE_TEST_HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  if (!options.path.startsWith("/v1/") || options.path.includes("..")) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }

  const url = new URL(options.path, config.apiOrigin);
  if (url.origin !== config.apiOrigin || url.hostname !== "api.test.fincode.jp") {
    throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${config.secretKey}`,
    };
    if (options.body) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers.idempotent_key = options.idempotencyKey;

    const response = await fetchImpl(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new FincodeTestError(
        response.status >= 500
          ? "FINCODE_TEST_PROVIDER_UNAVAILABLE"
          : "FINCODE_TEST_PAYMENT_REJECTED",
      );
    }
    return await readLimitedJson(response);
  } catch (error) {
    if (error instanceof FincodeTestError) throw error;
    throw new FincodeTestError("FINCODE_TEST_PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}
