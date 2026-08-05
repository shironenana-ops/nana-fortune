import type { FincodeTestEnvironment } from "./fincodeTestConfig";
import { loadFincodeTestPaymentConfig } from "./fincodeTestConfig";
import { FincodeTestError, isFincodeTestError } from "./fincodeTestErrors";
import type { FincodeTestFetch } from "./fincodeTestHttpClient";
import {
  registerFincodeTestPayment,
  validateFincodeTestPaymentId,
  validateFincodeTestRegistrationPayload,
  verifyFincodeTestPayment,
} from "./fincodeTestPayments";
import {
  FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
  FINCODE_TEST_LIGHT_COMPLETE_PATH,
  loadFincodeTestLightCheckoutConfig,
  prepareFincodeTestLightCheckout,
  subscribeFincodeTestLightCheckout,
  validateFincodeTestLightRequest,
  verifyFincodeTestLightBrowserSession,
  verifyFincodeTestLightSubscription,
  type FincodeTestLightIntentPort,
} from "./fincodeTestLightCheckout";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};
const HTML_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const MAX_REQUEST_BYTES = 1_024;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function localRequestUrl(request: Request): URL {
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
  }
  return url;
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeError(error: unknown): Response {
  const code = isFincodeTestError(error) ? error.code : "FINCODE_TEST_PROVIDER_UNAVAILABLE";
  if (code === "FINCODE_TEST_AUTH_REJECTED") {
    return json({ ok: false, code, message: "Light TEST用のログイン状態を確認できません。" }, 401);
  }
  if (code === "FINCODE_TEST_REQUEST_INVALID") {
    return json({ ok: false, code: "FINCODE_TEST_REQUEST_INVALID", message: "リクエストを確認してください。" }, 400);
  }
  if (code === "FINCODE_TEST_ENVIRONMENT_REJECTED") {
    return json({ ok: false, code: "FINCODE_TEST_ENVIRONMENT_REJECTED", message: "TEST決済を実行できない環境です。" }, 403);
  }
  if (code === "FINCODE_TEST_PAYMENT_REJECTED") {
    return json({ ok: false, code: "FINCODE_TEST_PAYMENT_REJECTED", message: "TEST決済を完了できませんでした。" }, 502);
  }
  return json({ ok: false, code, message: "TEST決済を現在利用できません。" }, 503);
}

async function strictJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
}

export async function handleFincodeTestRegistration(
  request: Request,
  env: FincodeTestEnvironment,
  fetchImpl?: FincodeTestFetch,
  lightIntents?: FincodeTestLightIntentPort,
): Promise<Response> {
  try {
    const url = localRequestUrl(request);
    if (request.method !== "POST") {
      return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POSTでリクエストしてください。" }, 405);
    }
    if (request.headers.get("origin") !== url.origin) {
      throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
    }
    const payload = await strictJsonBody(request);
    if (env.FINCODE_TEST_BROWSER_E2E_PROFILE === FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE && (payload as { plan?: unknown } | null)?.plan !== "light") {
      throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
    }
    if ((payload as { plan?: unknown } | null)?.plan === "light") {
      if (!lightIntents) throw new FincodeTestError("FINCODE_TEST_DISABLED");
      const lightRequest = validateFincodeTestLightRequest(payload);
      const config = loadFincodeTestLightCheckoutConfig(env);
      const userId = await verifyFincodeTestLightBrowserSession({
        config,
        authorization: request.headers.get("authorization"),
        fetchImpl,
      });
      if (lightRequest.action === "prepare") {
        const prepared = await prepareFincodeTestLightCheckout({ config, userId, intents: lightIntents, fetchImpl });
        return json({ ok: true, ...prepared }, 200);
      }
      const subscribed = await subscribeFincodeTestLightCheckout({
        config,
        userId,
        request: lightRequest,
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        intents: lightIntents,
        fetchImpl,
      });
      return json({ ok: true, ...subscribed }, 200);
    }
    const config = loadFincodeTestPaymentConfig(env);
    validateFincodeTestRegistrationPayload(payload);
    const idempotencyKey = request.headers.get("idempotency-key");
    const registered = await registerFincodeTestPayment({
      config,
      idempotencyKey: idempotencyKey ?? "",
      fetchImpl,
    });
    return json({ ok: true, ...registered }, 200);
  } catch (error) {
    return safeError(error);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function resultHtml(input: { title: string; message: string; retry: boolean }): string {
  const retry = input.retry ? "<p>時間をおいて、このページを再読み込みしてください。</p>" : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(input.title)} | 白音七</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f1a;color:#fff;font-family:sans-serif}.card{max-width:42rem;margin:1rem;padding:2rem;border:1px solid #8e7730;border-radius:1.25rem;background:#10142b;text-align:center}h1{color:#ffe58f}p{line-height:1.8}a{color:#ffe58f}</style></head><body><main class="card"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${retry}<p>このTESTでは実際の請求および白音七の権利付与は行いません。</p><a href="/checkout?plan=voice_single">申込内容確認へ戻る</a></main></body></html>`;
}

function failureResultHtml(input: { title: string; message: string; retry: boolean }): string {
  const retry = input.retry ? "<p>時間をおいて、このページを再読み込みしてからもう一度決済してください。</p>" : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(input.title)} | 白音七</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f1a;color:#fff;font-family:sans-serif}.card{max-width:42rem;margin:1rem;padding:2rem;border:1px solid #8e7730;border-radius:1.25rem;background:#10142b;text-align:center}h1{color:#ffe58f}p{line-height:1.8}a{color:#ffe58f}</style></head><body><main class="card"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${retry}<p>このTESTでは実際の請求および白音七の権利付与は行いません。</p><a href="/checkout?plan=voice_single">もう一度決済する</a></main></body></html>`;
}

export async function handleFincodeTestResult(
  request: Request,
  env: FincodeTestEnvironment,
  fetchImpl?: FincodeTestFetch,
  lightIntents?: FincodeTestLightIntentPort,
): Promise<Response> {
  try {
    const url = localRequestUrl(request);
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(resultHtml({ title: "確認できません", message: "許可されていない操作です。", retry: false }), { status: 405, headers: HTML_HEADERS });
    }
    if (url.searchParams.get("plan") === "light") {
      if (!lightIntents || request.method !== "GET") throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
      if ([...url.searchParams.keys()].sort().join(",") !== "customer_id,plan,purchase_intent_id,subscription_id") {
        throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
      }
      const lightConfig = loadFincodeTestLightCheckoutConfig(env);
      await verifyFincodeTestLightSubscription({
        config: lightConfig,
        customerId: url.searchParams.get("customer_id"),
        subscriptionId: url.searchParams.get("subscription_id"),
        purchaseIntentId: url.searchParams.get("purchase_intent_id"),
        intents: lightIntents,
        fetchImpl,
      });
      return new Response(null, {
        status: 303,
        headers: { "cache-control": "no-store", location: FINCODE_TEST_LIGHT_COMPLETE_PATH, "referrer-policy": "no-referrer" },
      });
    }
    if (env.FINCODE_TEST_BROWSER_E2E_PROFILE === FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE) {
      throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
    }
    const paymentId = validateFincodeTestPaymentId(url.searchParams.get("payment_id"));
    const config = loadFincodeTestPaymentConfig(env);
    await verifyFincodeTestPayment({ config, paymentId, fetchImpl });
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: "/fincode/test/complete",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const retryable = !isFincodeTestError(error)
      || error.code === "FINCODE_TEST_PROVIDER_UNAVAILABLE"
      || error.code === "FINCODE_TEST_RESPONSE_INVALID";
    const rejected = isFincodeTestError(error) && error.code === "FINCODE_TEST_PAYMENT_REJECTED";
    return new Response(
      failureResultHtml({
        title: rejected ? "TEST決済失敗" : retryable ? "確認を完了できません" : "TEST決済失敗",
        message: rejected ? "fincode TEST環境で決済完了を確認できませんでした。" : retryable ? "決済状態を安全に確認できませんでした。" : "入力内容または実行環境を確認してください。",
        retry: retryable,
      }),
      { status: retryable ? 503 : 400, headers: HTML_HEADERS },
    );
  }
}
