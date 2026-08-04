import { createHash } from "node:crypto";
import { BILLING_PLANS, FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE } from "../../../lib/billingPlans";
import {
  loadFincodeTestPaymentConfig,
  type FincodeTestEnvironment,
  type FincodeTestPaymentConfig,
} from "./fincodeTestConfig";
import { FincodeTestError } from "./fincodeTestErrors";
import { requestFincodeTestJson, type FincodeTestFetch } from "./fincodeTestHttpClient";
import { validateFincodeTestIdempotencyKey } from "./fincodeTestPayments";

export { FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE } from "../../../lib/billingPlans";

export const FINCODE_TEST_LIGHT_PLAN = "light" as const;
export const FINCODE_TEST_LIGHT_AMOUNT = 980;
export const FINCODE_TEST_LIGHT_BILLING_TYPE = "subscription" as const;
export const FINCODE_TEST_LIGHT_PAY_TYPE = "Card" as const;
export const FINCODE_TEST_LIGHT_COMPLETE_PATH = "/fincode/test/complete#light" as const;

const PLAN_REFERENCE = /^[A-Za-z0-9_-]{1,25}$/u;
const CUSTOMER_REFERENCE = /^[A-Za-z0-9_-]{1,60}$/u;
const CARD_REFERENCE = /^[A-Za-z0-9_-]{1,64}$/u;
const STAGING_USER_ID = /^[a-z0-9][a-z0-9._+-]{0,95}@staging\.invalid$/iu;
const MAX_AUTH_RESPONSE_BYTES = 16_384;

export type FincodeTestLightCheckoutConfig = FincodeTestPaymentConfig & {
  profile: typeof FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE;
  runtimeEnvironment: "local-staging";
  membershipStatusUrl: string;
  startDate: string;
};

export type FincodeTestLightPurchaseIntent = {
  id: string;
  userId: string;
  customerId: string;
  planReference: string;
  product: typeof FINCODE_TEST_LIGHT_PLAN;
  amount: typeof FINCODE_TEST_LIGHT_AMOUNT;
  billingType: typeof FINCODE_TEST_LIGHT_BILLING_TYPE;
};

export type FincodeTestLightIntentPort = {
  prepare(intent: FincodeTestLightPurchaseIntent): Promise<"READY" | "CONFLICT" | "UNAVAILABLE">;
  find(customerId: string): Promise<FincodeTestLightPurchaseIntent | null>;
  markSubmitted(intent: FincodeTestLightPurchaseIntent, subscriptionId: string): Promise<"SUBMITTED" | "CONFLICT" | "UNAVAILABLE">;
};

export type FincodeTestLightPrepareResult = {
  action: "prepare";
  product: typeof FINCODE_TEST_LIGHT_PLAN;
  amount: typeof FINCODE_TEST_LIGHT_AMOUNT;
  billingType: typeof FINCODE_TEST_LIGHT_BILLING_TYPE;
  customerId: string;
  purchaseIntentId: string;
};

export type FincodeTestLightSubscriptionResult = {
  action: "subscribe";
  product: typeof FINCODE_TEST_LIGHT_PLAN;
  amount: typeof FINCODE_TEST_LIGHT_AMOUNT;
  billingType: typeof FINCODE_TEST_LIGHT_BILLING_TYPE;
  subscriptionId: string;
  purchaseIntentId: string;
  status: "ACTIVE" | "RUNNING";
};

export type FincodeTestLightRequest =
  | { action: "prepare"; plan: typeof FINCODE_TEST_LIGHT_PLAN }
  | { action: "subscribe"; plan: typeof FINCODE_TEST_LIGHT_PLAN; customerId: string; purchaseIntentId: string; cardId: string };

function requiredExact(value: unknown, expected: string): void {
  if (value !== expected) throw new FincodeTestError("FINCODE_TEST_ENVIRONMENT_REJECTED");
}

function stagingMembershipStatusUrl(value: unknown): string {
  if (typeof value !== "string") throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID"); }
  if (
    url.protocol !== "https:"
    || !url.hostname.endsWith(".execute-api.ap-northeast-1.amazonaws.com")
    || url.pathname !== "/staging/membership/status"
    || url.username
    || url.password
    || url.search
    || url.hash
    || /prod|production/iu.test(url.href)
  ) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  return url.href;
}

function approvedTestStartDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}\/\d{2}\/\d{2}$/u.test(value)) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  const [year, month, day] = value.split("/").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  return value;
}

export function loadFincodeTestLightCheckoutConfig(env: FincodeTestEnvironment): FincodeTestLightCheckoutConfig {
  const provider = loadFincodeTestPaymentConfig(env);
  requiredExact(env.PUBLIC_RUNTIME_ENV, "local-staging");
  requiredExact(env.PUBLIC_STAGING_AUTH_ENABLED, "true");
  requiredExact(env.PUBLIC_FINCODE_TEST_BROWSER_E2E_PROFILE, FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE);
  requiredExact(env.FINCODE_TEST_BROWSER_E2E_PROFILE, FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE);
  const base = typeof env.PUBLIC_STAGING_API_BASE_URL === "string"
    ? env.PUBLIC_STAGING_API_BASE_URL.replace(/\/$/u, "")
    : "";
  return {
    ...provider,
    profile: FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
    runtimeEnvironment: "local-staging",
    membershipStatusUrl: stagingMembershipStatusUrl(`${base}/membership/status`),
    startDate: approvedTestStartDate(env.FINCODE_TEST_LIGHT_START_DATE),
  };
}

function exactAmount(value: unknown): boolean {
  return value === FINCODE_TEST_LIGHT_AMOUNT || value === String(FINCODE_TEST_LIGHT_AMOUNT);
}

function exactZero(value: unknown): boolean {
  return value === 0 || value === "0";
}

function providerReference(value: unknown): value is string {
  return typeof value === "string" && PLAN_REFERENCE.test(value);
}

function lightPlan(record: Record<string, unknown>): boolean {
  return providerReference(record.id)
    && exactAmount(record.amount)
    && exactZero(record.tax)
    && (record.total_amount === undefined || record.total_amount === null || exactAmount(record.total_amount))
    && record.interval_pattern === "month"
    && (record.interval_count === 1 || record.interval_count === "1")
    && record.delete_flag !== "1";
}

export async function resolveFincodeTestLightPlanReference(input: {
  config: FincodeTestLightCheckoutConfig;
  fetchImpl?: FincodeTestFetch;
}): Promise<string> {
  const catalog = await requestFincodeTestJson(input.config, { method: "GET", path: "/v1/plans" }, input.fetchImpl);
  const matches = Array.isArray(catalog.list)
    ? catalog.list.filter((entry): entry is Record<string, unknown> => (
        !!entry && typeof entry === "object" && !Array.isArray(entry) && lightPlan(entry as Record<string, unknown>)
      ))
    : [];
  if (matches.length !== 1 || !providerReference(matches[0]?.id)) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  return matches[0].id;
}

export function validateFincodeTestLightRequest(value: unknown): FincodeTestLightRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  const payload = value as Record<string, unknown>;
  if (payload.plan !== FINCODE_TEST_LIGHT_PLAN) throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  if (payload.action === "prepare" && Object.keys(payload).sort().join(",") === "action,plan") {
    return { action: "prepare", plan: FINCODE_TEST_LIGHT_PLAN };
  }
  if (
    payload.action === "subscribe"
    && Object.keys(payload).sort().join(",") === "action,cardId,customerId,plan,purchaseIntentId"
    && typeof payload.customerId === "string" && CUSTOMER_REFERENCE.test(payload.customerId)
    && typeof payload.purchaseIntentId === "string" && PLAN_REFERENCE.test(payload.purchaseIntentId)
    && typeof payload.cardId === "string" && CARD_REFERENCE.test(payload.cardId)
  ) {
    return {
      action: "subscribe",
      plan: FINCODE_TEST_LIGHT_PLAN,
      customerId: payload.customerId,
      purchaseIntentId: payload.purchaseIntentId,
      cardId: payload.cardId,
    };
  }
  throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
}

function decodeValidatedSessionSubject(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0] ?? "")) {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  try {
    const canonical = Buffer.from(parts[0], "base64url");
    if (canonical.toString("base64url") !== parts[0]) throw new Error("non-canonical");
    const payload = JSON.parse(canonical.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid");
    const userId = (payload as Record<string, unknown>).user_id;
    if (typeof userId !== "string" || !STAGING_USER_ID.test(userId)) throw new Error("invalid");
    return userId;
  } catch {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
}

async function readBoundedAuthResponse(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_AUTH_RESPONSE_BYTES)) {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
}

export async function verifyFincodeTestLightBrowserSession(input: {
  config: FincodeTestLightCheckoutConfig;
  authorization: unknown;
  fetchImpl?: FincodeTestFetch;
}): Promise<string> {
  if (typeof input.authorization !== "string" || !input.authorization.startsWith("Bearer ")) {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  const token = input.authorization.slice("Bearer ".length).trim();
  if (!token || token.length > 4_096) throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  const response = await (input.fetchImpl ?? fetch)(input.config.membershipStatusUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "manual",
  });
  if (response.status !== 200) throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  const membership = await readBoundedAuthResponse(response);
  if (membership.plan !== "free" || membership.subscription_status !== "inactive") {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  return decodeValidatedSessionSubject(token);
}

function stableReference(prefix: "pi_" | "su_" | "stg_customer_ui_", userId: string): string {
  const digest = createHash("sha256")
    .update(`shirone-fincode-test-light-browser-e2e-v2\0${userId}`, "utf8")
    .digest("base64url");
  const size = prefix === "stg_customer_ui_" ? 24 : 22;
  return `${prefix}${digest.slice(0, size)}`;
}

async function ensureFincodeTestCustomer(input: {
  config: FincodeTestLightCheckoutConfig;
  customerId: string;
  fetchImpl?: FincodeTestFetch;
}): Promise<void> {
  try {
    const existing = await requestFincodeTestJson(
      input.config,
      { method: "GET", path: `/v1/customers/${encodeURIComponent(input.customerId)}` },
      input.fetchImpl,
    );
    if (existing.id !== input.customerId) throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
    return;
  } catch {
    // A deterministic TEST customer may not exist yet. Creation is retried only by
    // the browser's explicit action; the server never substitutes another product.
  }
  try {
    const created = await requestFincodeTestJson(
      input.config,
      { method: "POST", path: "/v1/customers", body: { id: input.customerId } },
      input.fetchImpl,
    );
    if (created.id !== input.customerId) throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  } catch {
    const existing = await requestFincodeTestJson(
      input.config,
      { method: "GET", path: `/v1/customers/${encodeURIComponent(input.customerId)}` },
      input.fetchImpl,
    );
    if (existing.id !== input.customerId) throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
}

export async function prepareFincodeTestLightCheckout(input: {
  config: FincodeTestLightCheckoutConfig;
  userId: string;
  intents: FincodeTestLightIntentPort;
  fetchImpl?: FincodeTestFetch;
}): Promise<FincodeTestLightPrepareResult> {
  if (BILLING_PLANS.light.price !== FINCODE_TEST_LIGHT_AMOUNT || BILLING_PLANS.light.billingType !== FINCODE_TEST_LIGHT_BILLING_TYPE) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  const planReference = await resolveFincodeTestLightPlanReference(input);
  const intent: FincodeTestLightPurchaseIntent = {
    id: stableReference("pi_", input.userId),
    userId: input.userId,
    customerId: stableReference("stg_customer_ui_", input.userId),
    planReference,
    product: FINCODE_TEST_LIGHT_PLAN,
    amount: FINCODE_TEST_LIGHT_AMOUNT,
    billingType: FINCODE_TEST_LIGHT_BILLING_TYPE,
  };
  if (await input.intents.prepare(intent) !== "READY") throw new FincodeTestError("FINCODE_TEST_PROVIDER_UNAVAILABLE");
  await ensureFincodeTestCustomer({ config: input.config, customerId: intent.customerId, fetchImpl: input.fetchImpl });
  return {
    action: "prepare",
    product: intent.product,
    amount: intent.amount,
    billingType: intent.billingType,
    customerId: intent.customerId,
    purchaseIntentId: intent.id,
  };
}

function validateSubscriptionBoundary(record: Record<string, unknown>, input: {
  config: FincodeTestLightCheckoutConfig;
  intent: FincodeTestLightPurchaseIntent;
  subscriptionId: string;
  cardId?: string;
}): "ACTIVE" | "RUNNING" {
  if (
    record.id !== input.subscriptionId
    || record.shop_id !== input.config.shopId
    || record.pay_type !== FINCODE_TEST_LIGHT_PAY_TYPE
    || record.plan_id !== input.intent.planReference
    || record.customer_id !== input.intent.customerId
    || (input.cardId !== undefined && record.card_id !== input.cardId)
    || record.client_field_1 !== FINCODE_TEST_LIGHT_PLAN
    || record.client_field_2 !== input.intent.id
    || record.client_field_3 !== FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE
    || (record.status !== "ACTIVE" && record.status !== "RUNNING")
  ) {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
  return record.status;
}

export async function subscribeFincodeTestLightCheckout(input: {
  config: FincodeTestLightCheckoutConfig;
  userId: string;
  request: Extract<FincodeTestLightRequest, { action: "subscribe" }>;
  idempotencyKey: string;
  intents: FincodeTestLightIntentPort;
  fetchImpl?: FincodeTestFetch;
}): Promise<FincodeTestLightSubscriptionResult> {
  const idempotencyKey = validateFincodeTestIdempotencyKey(input.idempotencyKey);
  const intent = await input.intents.find(input.request.customerId);
  if (
    !intent
    || intent.userId !== input.userId
    || intent.id !== input.request.purchaseIntentId
    || intent.product !== FINCODE_TEST_LIGHT_PLAN
    || intent.amount !== FINCODE_TEST_LIGHT_AMOUNT
    || intent.billingType !== FINCODE_TEST_LIGHT_BILLING_TYPE
  ) {
    throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  }
  const currentPlanReference = await resolveFincodeTestLightPlanReference(input);
  if (currentPlanReference !== intent.planReference) throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  const subscriptionId = stableReference("su_", input.userId);
  let record: Record<string, unknown>;
  try {
    record = await requestFincodeTestJson(input.config, {
      method: "POST",
      path: "/v1/subscriptions",
      idempotencyKey,
      body: {
        id: subscriptionId,
        pay_type: FINCODE_TEST_LIGHT_PAY_TYPE,
        plan_id: intent.planReference,
        customer_id: intent.customerId,
        card_id: input.request.cardId,
        start_date: input.config.startDate,
        client_field_1: FINCODE_TEST_LIGHT_PLAN,
        client_field_2: intent.id,
        client_field_3: FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
      },
    }, input.fetchImpl);
  } catch {
    record = await requestFincodeTestJson(input.config, {
      method: "GET",
      path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}?pay_type=Card`,
    }, input.fetchImpl);
  }
  const status = validateSubscriptionBoundary(record, { config: input.config, intent, subscriptionId, cardId: input.request.cardId });
  if (await input.intents.markSubmitted(intent, subscriptionId) !== "SUBMITTED") {
    throw new FincodeTestError("FINCODE_TEST_PROVIDER_UNAVAILABLE");
  }
  return {
    action: "subscribe",
    product: FINCODE_TEST_LIGHT_PLAN,
    amount: FINCODE_TEST_LIGHT_AMOUNT,
    billingType: FINCODE_TEST_LIGHT_BILLING_TYPE,
    subscriptionId,
    purchaseIntentId: intent.id,
    status,
  };
}

export async function verifyFincodeTestLightSubscription(input: {
  config: FincodeTestLightCheckoutConfig;
  customerId: unknown;
  subscriptionId: unknown;
  purchaseIntentId: unknown;
  intents: FincodeTestLightIntentPort;
  fetchImpl?: FincodeTestFetch;
}): Promise<void> {
  if (
    typeof input.customerId !== "string" || !CUSTOMER_REFERENCE.test(input.customerId)
    || !providerReference(input.subscriptionId)
    || !providerReference(input.purchaseIntentId)
  ) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  const intent = await input.intents.find(input.customerId);
  if (!intent || intent.id !== input.purchaseIntentId) throw new FincodeTestError("FINCODE_TEST_AUTH_REJECTED");
  const record = await requestFincodeTestJson(input.config, {
    method: "GET",
    path: `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}?pay_type=Card`,
  }, input.fetchImpl);
  validateSubscriptionBoundary(record, { config: input.config, intent, subscriptionId: input.subscriptionId });
}
