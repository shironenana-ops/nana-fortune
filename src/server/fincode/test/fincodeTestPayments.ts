import { BILLING_PLANS } from "../../../lib/billingPlans";
import type { FincodeTestPaymentConfig } from "./fincodeTestConfig";
import { FincodeTestError } from "./fincodeTestErrors";
import {
  requestFincodeTestJson,
  type FincodeTestFetch,
} from "./fincodeTestHttpClient";

export const FINCODE_TEST_PLAN = "voice_single" as const;
export const FINCODE_TEST_AMOUNT = 300;
export const FINCODE_TEST_PAY_TYPE = "Card" as const;
export const FINCODE_TEST_JOB_CODE = "CAPTURE" as const;

const PAYMENT_ID = /^[A-Za-z0-9_-]{1,30}$/u;
const ACCESS_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PaymentRecord = Record<string, unknown>;

function exactAmount(value: unknown): boolean {
  return value === FINCODE_TEST_AMOUNT || value === String(FINCODE_TEST_AMOUNT);
}

function exactZero(value: unknown): boolean {
  return value === 0 || value === "0";
}

function validatePaymentBoundary(record: PaymentRecord, config: FincodeTestPaymentConfig): void {
  if (
    record.shop_id !== config.shopId
    || record.pay_type !== FINCODE_TEST_PAY_TYPE
    || record.job_code !== FINCODE_TEST_JOB_CODE
    || !exactAmount(record.amount)
    || !exactZero(record.tax)
    || (record.total_amount !== undefined && record.total_amount !== null && !exactAmount(record.total_amount))
  ) {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
}

export type RegisteredFincodeTestPayment = {
  paymentId: string;
  accessId: string;
  payType: typeof FINCODE_TEST_PAY_TYPE;
};

export type VerifiedFincodeTestPayment = {
  paymentId: string;
  status: "CAPTURED";
};

export function validateFincodeTestRegistrationPayload(value: unknown): typeof FINCODE_TEST_PLAN {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || payload.plan !== FINCODE_TEST_PLAN) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  return FINCODE_TEST_PLAN;
}

export function validateFincodeTestIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  return value;
}

export function validateFincodeTestPaymentId(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_ID.test(value)) {
    throw new FincodeTestError("FINCODE_TEST_REQUEST_INVALID");
  }
  return value;
}

export async function registerFincodeTestPayment(input: {
  config: FincodeTestPaymentConfig;
  idempotencyKey: string;
  fetchImpl?: FincodeTestFetch;
}): Promise<RegisteredFincodeTestPayment> {
  if (BILLING_PLANS[FINCODE_TEST_PLAN].price !== FINCODE_TEST_AMOUNT) {
    throw new FincodeTestError("FINCODE_TEST_CONFIGURATION_INVALID");
  }
  const idempotencyKey = validateFincodeTestIdempotencyKey(input.idempotencyKey);
  const record = await requestFincodeTestJson(
    input.config,
    {
      method: "POST",
      path: "/v1/payments",
      idempotencyKey,
      body: {
        pay_type: FINCODE_TEST_PAY_TYPE,
        job_code: FINCODE_TEST_JOB_CODE,
        amount: String(FINCODE_TEST_AMOUNT),
        tax: "0",
        tds_type: "2",
        tds2_type: "2",
      },
    },
    input.fetchImpl,
  );

  validatePaymentBoundary(record, input.config);
  if (
    typeof record.id !== "string"
    || !PAYMENT_ID.test(record.id)
    || typeof record.access_id !== "string"
    || !ACCESS_ID.test(record.access_id)
    || record.status !== "UNPROCESSED"
  ) {
    throw new FincodeTestError("FINCODE_TEST_RESPONSE_INVALID");
  }
  return { paymentId: record.id, accessId: record.access_id, payType: FINCODE_TEST_PAY_TYPE };
}

export async function verifyFincodeTestPayment(input: {
  config: FincodeTestPaymentConfig;
  paymentId: string;
  fetchImpl?: FincodeTestFetch;
}): Promise<VerifiedFincodeTestPayment> {
  const paymentId = validateFincodeTestPaymentId(input.paymentId);
  const record = await requestFincodeTestJson(
    input.config,
    { method: "GET", path: `/v1/payments/${encodeURIComponent(paymentId)}?pay_type=Card` },
    input.fetchImpl,
  );
  validatePaymentBoundary(record, input.config);
  if (record.id !== paymentId || record.status !== "CAPTURED") {
    throw new FincodeTestError("FINCODE_TEST_PAYMENT_REJECTED");
  }
  return { paymentId, status: "CAPTURED" };
}
