import { adaptFincodeWebhookHttpEvent, fincodeWebhookAcknowledgedResponse, fincodeWebhookRejectedResponse, fincodeWebhookRetryResponse, type FincodeWebhookHttpResponse } from "./webhookHttpAdapter";
import { verifyFincodeWebhookSignature } from "./webhookSignature";
import { grantFincodeOneTimeVoicePurchase, type FincodeOneTimeVoiceAtomicGrantPort, type FincodeOneTimeVoicePurchaseIntentPort, type VerifiedFincodeOneTimeVoicePayment } from "./oneTimeVoicePurchase";
import type { ProvisionalFincodeTestProviderConfig } from "./provisionalFincodeTestPeriodSource";

const TRIGGER_EVENTS = new Set(["payments.card.exec", "payments.card.capture", "payments.card.secure"]);
const REF = /^[A-Za-z0-9_-]{1,60}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function getVerifiedPayment(config: ProvisionalFincodeTestProviderConfig, paymentReference: string): Promise<VerifiedFincodeOneTimeVoicePayment | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = new URL(`/v1/payments/${encodeURIComponent(paymentReference)}?pay_type=Card`, config.apiOrigin);
    if (url.origin !== config.apiOrigin || url.hostname !== "api.test.fincode.jp") return null;
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json", authorization: `Bearer ${config.secretKey}` } });
    if (!response.ok) return null;
    const value = await response.json();
    if (!record(value) || value.id !== paymentReference || value.shop_id !== config.shopId || value.amount !== 300 || value.tax !== 0 || value.pay_type !== "Card" || value.job_code !== "CAPTURE" || value.status !== "CAPTURED") return null;
    return { environment: "staging", shopReference: config.shopId, paymentReference, amount: 300, payType: "Card", jobCode: "CAPTURE", status: "CAPTURED" };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function orchestrateFincodeOneTimeVoiceWebhook(input: {
  event: unknown;
  expectedSignature: string;
  provider: ProvisionalFincodeTestProviderConfig;
  intents: FincodeOneTimeVoicePurchaseIntentPort;
  grants: FincodeOneTimeVoiceAtomicGrantPort;
  auditSink?: (line: string) => void;
  now?: () => number;
}): Promise<FincodeWebhookHttpResponse> {
  const audit = (resultCode: "VOICE_SIGNATURE_DENIED" | "VOICE_SCHEMA_DENIED" | "VOICE_PROVIDER_UNAVAILABLE" | "VOICE_COMPLETED" | "VOICE_DUPLICATE" | "VOICE_REJECTED" | "VOICE_RETRYABLE") =>
    (input.auditSink ?? console.log)(JSON.stringify({ event: "fincode_voice_single", result_code: resultCode }));
  let adapted;
  let parsed: unknown;
  try {
    adapted = adaptFincodeWebhookHttpEvent(input.event);
    verifyFincodeWebhookSignature({ headers: adapted.headers, expectedSignature: input.expectedSignature });
    parsed = JSON.parse(adapted.rawBody);
  } catch { audit("VOICE_SIGNATURE_DENIED"); return fincodeWebhookRejectedResponse(401); }
  if (!record(parsed) || typeof parsed.event !== "string" || !TRIGGER_EVENTS.has(parsed.event) || parsed.pay_type !== "Card" || typeof parsed.order_id !== "string" || !REF.test(parsed.order_id)) {
    audit("VOICE_SCHEMA_DENIED");
    return fincodeWebhookRejectedResponse(400);
  }
  const payment = await getVerifiedPayment(input.provider, parsed.order_id);
  if (!payment) { audit("VOICE_PROVIDER_UNAVAILABLE"); return fincodeWebhookRetryResponse(); }
  const result = await grantFincodeOneTimeVoicePurchase({ payment, intents: input.intents, grants: input.grants, completedAt: new Date((input.now ?? Date.now)()).toISOString() });
  if (result === "COMPLETED") { audit("VOICE_COMPLETED"); return fincodeWebhookAcknowledgedResponse(); }
  if (result === "ALREADY_COMPLETED") { audit("VOICE_DUPLICATE"); return fincodeWebhookAcknowledgedResponse(); }
  if (result === "REJECTED") { audit("VOICE_REJECTED"); return fincodeWebhookRejectedResponse(409); }
  audit("VOICE_RETRYABLE");
  return fincodeWebhookRetryResponse();
}
