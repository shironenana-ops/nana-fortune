import { createHash } from "node:crypto";
import {
  FINCODE_SUBSCRIPTION_EVENTS,
  FINCODE_SUBSCRIPTION_STATUSES,
  FincodeWebhookError,
  type FincodeSubscriptionEventType,
  type FincodeSubscriptionStatus,
  type FincodeWebhookBoundary,
  type ValidatedFincodeSubscriptionPayload,
} from "./webhookTypes";

export const FINCODE_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

const EVENT_SET = new Set<string>(FINCODE_SUBSCRIPTION_EVENTS);
const STATUS_SET = new Set<string>(FINCODE_SUBSCRIPTION_STATUSES);
const DATETIME = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u;
const SAFE_EXTERNAL_REFERENCE = /^[A-Za-z0-9_-]+$/u;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredString(record: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < min || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string, max: number): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }
  return value;
}

function validDateTime(value: string): boolean {
  const match = DATETIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, millis] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +millis));
  return date.getUTCFullYear() === +year && date.getUTCMonth() === +month - 1 &&
    date.getUTCDate() === +day && date.getUTCHours() === +hour &&
    date.getUTCMinutes() === +minute && date.getUTCSeconds() === +second &&
    date.getUTCMilliseconds() === +millis;
}

function dateTime(record: Record<string, unknown>, key: string, nullable = false): string | null {
  const value = record[key];
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !validDateTime(value)) {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }
  return value;
}

function validateCustomerReference(value: string, boundary: FincodeWebhookBoundary): void {
  const expectedEnvironmentPrefix = boundary.environment === "staging" ? "stg_" : "prd_";
  if (!boundary.customerReferencePrefix.startsWith(expectedEnvironmentPrefix) ||
      value.length < boundary.customerReferencePrefix.length + 24 || value.length > 60 ||
      !value.startsWith(boundary.customerReferencePrefix) ||
      !SAFE_EXTERNAL_REFERENCE.test(value) || value.includes("@")) {
    throw new FincodeWebhookError("WEBHOOK_CUSTOMER_REFERENCE_INVALID");
  }
}

function assertNotProductionIdentifier(values: readonly string[], boundary: FincodeWebhookBoundary): void {
  if (boundary.environment !== "staging" || !boundary.productionIdentifiers?.size) return;
  if (values.some((value) => boundary.productionIdentifiers!.has(value))) {
    throw new FincodeWebhookError("WEBHOOK_PRODUCTION_IDENTIFIER_REJECTED");
  }
}

export function validateFincodeWebhookTransport(params: {
  method: unknown;
  contentType: unknown;
  rawBody: unknown;
}): string {
  if (params.method !== "POST") throw new FincodeWebhookError("WEBHOOK_METHOD_INVALID");
  if (typeof params.contentType !== "string" ||
      params.contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new FincodeWebhookError("WEBHOOK_CONTENT_TYPE_INVALID");
  }
  if (typeof params.rawBody !== "string") throw new FincodeWebhookError("WEBHOOK_JSON_INVALID");
  if (Buffer.byteLength(params.rawBody, "utf8") > FINCODE_WEBHOOK_MAX_BODY_BYTES) {
    throw new FincodeWebhookError("WEBHOOK_BODY_TOO_LARGE");
  }
  return params.rawBody;
}

export function parseFincodeSubscriptionPayload(
  rawBody: string,
  boundary: FincodeWebhookBoundary,
): ValidatedFincodeSubscriptionPayload {
  if (!boundary.enabled) throw new FincodeWebhookError("WEBHOOK_DISABLED");
  if (boundary.environment !== "staging" && boundary.environment !== "production") {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }
  if (!boundary.customerReferencePrefix || (boundary.allowedShopRefs.size === 0 && !boundary.allowedShopDigests?.size) || boundary.allowedPlanRefs.size === 0) {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new FincodeWebhookError("WEBHOOK_JSON_INVALID");
  }
  if (!plainRecord(parsed)) throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");

  const event = requiredString(parsed, "event", 1, 40);
  if (!EVENT_SET.has(event)) throw new FincodeWebhookError("WEBHOOK_EVENT_UNSUPPORTED");
  const status = requiredString(parsed, "status", 6, 10);
  if (!STATUS_SET.has(status)) throw new FincodeWebhookError("WEBHOOK_STATUS_UNSUPPORTED");
  const shopId = requiredString(parsed, "shop_id", 13, 13);
  const planId = requiredString(parsed, "plan_id", 1, 25);
  const subscriptionId = parsed.subscription_id;
  if (typeof subscriptionId !== "string" || subscriptionId.length < 1 || subscriptionId.length > 25) {
    throw new FincodeWebhookError("WEBHOOK_SUBSCRIPTION_REFERENCE_REQUIRED");
  }
  const customerId = requiredString(parsed, "customer_id", 1, 60);
  if (requiredString(parsed, "pay_type", 4, 4) !== "Card") {
    throw new FincodeWebhookError("WEBHOOK_SCHEMA_INVALID");
  }

  assertNotProductionIdentifier([shopId, planId, subscriptionId, customerId], boundary);
  const shopDigest = createHash("sha256").update(shopId, "utf8").digest("hex");
  if (!boundary.allowedShopRefs.has(shopId) && !boundary.allowedShopDigests?.has(shopDigest)) throw new FincodeWebhookError("WEBHOOK_SHOP_NOT_ALLOWED");
  if (!boundary.allowedPlanRefs.has(planId)) throw new FincodeWebhookError("WEBHOOK_PLAN_NOT_ALLOWED");
  validateCustomerReference(customerId, boundary);

  return {
    event: event as FincodeSubscriptionEventType,
    shopId,
    subscriptionId,
    planId,
    customerId,
    status: status as FincodeSubscriptionStatus,
    processDate: dateTime(parsed, "process_date")!,
    startDate: dateTime(parsed, "start_date", true),
    stopDate: dateTime(parsed, "stop_date", true),
    clientFields: [
      nullableString(parsed, "client_field_1", 100),
      nullableString(parsed, "client_field_2", 100),
      nullableString(parsed, "client_field_3", 100),
    ],
  };
}
