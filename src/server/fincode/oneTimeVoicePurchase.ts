import { createHash } from "node:crypto";

export const FINCODE_ONE_TIME_VOICE_PRODUCT = "voice_single" as const;
export const FINCODE_ONE_TIME_VOICE_AMOUNT = 300;
export const FINCODE_ONE_TIME_VOICE_PAY_TYPE = "Card" as const;
export const FINCODE_ONE_TIME_VOICE_JOB_CODE = "CAPTURE" as const;

export type FincodeOneTimeVoiceEnvironment = "test" | "staging";
export type FincodeOneTimeVoicePurchaseState = "REGISTERED" | "COMPLETED";

export type FincodeOneTimeVoicePurchaseIntent = {
  paymentDigest: string;
  payloadFingerprint: string;
  userReference: string;
  environment: FincodeOneTimeVoiceEnvironment;
  shopDigest: string;
  product: typeof FINCODE_ONE_TIME_VOICE_PRODUCT;
  amount: typeof FINCODE_ONE_TIME_VOICE_AMOUNT;
  state: FincodeOneTimeVoicePurchaseState;
};

export type VerifiedFincodeOneTimeVoicePayment = {
  environment: FincodeOneTimeVoiceEnvironment;
  shopReference: string;
  paymentReference: string;
  amount: number;
  payType: typeof FINCODE_ONE_TIME_VOICE_PAY_TYPE;
  jobCode: typeof FINCODE_ONE_TIME_VOICE_JOB_CODE;
  status: "CAPTURED";
};

export type FincodeOneTimeVoiceGrantResult =
  | "COMPLETED"
  | "ALREADY_COMPLETED"
  | "REJECTED"
  | "RETRYABLE_FAILURE";

export interface FincodeOneTimeVoicePurchaseIntentPort {
  createRegistered(input: FincodeOneTimeVoicePurchaseIntent): Promise<"CREATED" | "CONFLICT" | "UNAVAILABLE">;
  findByPaymentDigest(paymentDigest: string): Promise<FincodeOneTimeVoicePurchaseIntent | null>;
}

export interface FincodeOneTimeVoiceAtomicGrantPort {
  grant(input: {
    purchase: FincodeOneTimeVoicePurchaseIntent;
    completedAt: string;
  }): Promise<"COMPLETED" | "ALREADY_COMPLETED" | "RETRYABLE_FAILURE">;
}

export interface FincodeOneTimeVoicePaymentRegistrationPort {
  register(): Promise<{ shopReference: string; paymentReference: string }>;
}

const OPAQUE_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactEnvironment(value: unknown): value is FincodeOneTimeVoiceEnvironment {
  return value === "test" || value === "staging";
}

function validReference(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REFERENCE.test(value);
}

export function createFincodeOneTimeVoicePaymentDigest(input: {
  environment: FincodeOneTimeVoiceEnvironment;
  shopReference: string;
  paymentReference: string;
}): string {
  if (!exactEnvironment(input.environment) || !validReference(input.shopReference) || !validReference(input.paymentReference)) {
    throw new Error("FINCODE_ONE_TIME_VOICE_PAYMENT_INVALID");
  }
  return digest(`fincode-one-time-voice-v1\0${input.environment}\0${input.shopReference}\0${input.paymentReference}`);
}

export function createFincodeOneTimeVoicePayloadFingerprint(input: {
  environment: FincodeOneTimeVoiceEnvironment;
  shopReference: string;
  paymentReference: string;
  amount: number;
  payType: string;
  jobCode: string;
  status: string;
}): string {
  if (!exactEnvironment(input.environment) || !validReference(input.shopReference) || !validReference(input.paymentReference)) {
    throw new Error("FINCODE_ONE_TIME_VOICE_PAYMENT_INVALID");
  }
  return digest([
    "fincode-one-time-voice-payload-v1", input.environment, input.shopReference, input.paymentReference,
    String(input.amount), input.payType, input.jobCode, input.status,
  ].join("\0"));
}

export function createFincodeOneTimeVoicePurchaseIntent(input: {
  environment: FincodeOneTimeVoiceEnvironment;
  shopReference: string;
  paymentReference: string;
  userReference: string;
}): FincodeOneTimeVoicePurchaseIntent {
  if (!validReference(input.userReference)) throw new Error("FINCODE_ONE_TIME_VOICE_USER_INVALID");
  const paymentDigest = createFincodeOneTimeVoicePaymentDigest(input);
  const payloadFingerprint = createFincodeOneTimeVoicePayloadFingerprint({
    ...input,
    amount: FINCODE_ONE_TIME_VOICE_AMOUNT,
    payType: FINCODE_ONE_TIME_VOICE_PAY_TYPE,
    jobCode: FINCODE_ONE_TIME_VOICE_JOB_CODE,
    status: "CAPTURED",
  });
  return {
    paymentDigest,
    payloadFingerprint,
    userReference: input.userReference,
    environment: input.environment,
    shopDigest: digest(`fincode-one-time-voice-shop-v1\0${input.shopReference}`),
    product: FINCODE_ONE_TIME_VOICE_PRODUCT,
    amount: FINCODE_ONE_TIME_VOICE_AMOUNT,
    state: "REGISTERED",
  };
}

/**
 * The caller must obtain userReference from a verified server-side session.
 * This function deliberately persists the intent before it returns the payment
 * reference to a card-UI caller.
 */
export async function registerFincodeOneTimeVoicePurchase(input: {
  environment: FincodeOneTimeVoiceEnvironment;
  userReference: string;
  payments: FincodeOneTimeVoicePaymentRegistrationPort;
  intents: FincodeOneTimeVoicePurchaseIntentPort;
}): Promise<
  | { status: "REGISTERED"; paymentReference: string }
  | { status: "CONFLICT" | "UNAVAILABLE" }
> {
  if (!exactEnvironment(input.environment) || !validReference(input.userReference)) return { status: "UNAVAILABLE" };
  let registered: { shopReference: string; paymentReference: string };
  try {
    registered = await input.payments.register();
  } catch {
    return { status: "UNAVAILABLE" };
  }
  let intent: FincodeOneTimeVoicePurchaseIntent;
  try {
    intent = createFincodeOneTimeVoicePurchaseIntent({
      environment: input.environment,
      shopReference: registered.shopReference,
      paymentReference: registered.paymentReference,
      userReference: input.userReference,
    });
  } catch {
    return { status: "UNAVAILABLE" };
  }
  let created: "CREATED" | "CONFLICT" | "UNAVAILABLE";
  try {
    created = await input.intents.createRegistered(intent);
  } catch {
    created = "UNAVAILABLE";
  }
  return created === "CREATED"
    ? { status: "REGISTERED", paymentReference: registered.paymentReference }
    : { status: created };
}

function isExactRegisteredIntent(value: FincodeOneTimeVoicePurchaseIntent | null): value is FincodeOneTimeVoicePurchaseIntent {
  return !!value
    && HEX_DIGEST.test(value.paymentDigest)
    && HEX_DIGEST.test(value.payloadFingerprint)
    && HEX_DIGEST.test(value.shopDigest)
    && validReference(value.userReference)
    && exactEnvironment(value.environment)
    && value.product === FINCODE_ONE_TIME_VOICE_PRODUCT
    && value.amount === FINCODE_ONE_TIME_VOICE_AMOUNT
    && (value.state === "REGISTERED" || value.state === "COMPLETED");
}

function isExactCapturedPayment(value: VerifiedFincodeOneTimeVoicePayment): boolean {
  return exactEnvironment(value.environment)
    && validReference(value.shopReference)
    && validReference(value.paymentReference)
    && value.amount === FINCODE_ONE_TIME_VOICE_AMOUNT
    && value.payType === FINCODE_ONE_TIME_VOICE_PAY_TYPE
    && value.jobCode === FINCODE_ONE_TIME_VOICE_JOB_CODE
    && value.status === "CAPTURED";
}

/**
 * This receives a provider-verified capture, never raw Webhook JSON.  The HTTP
 * boundary must verify Fincode-Signature before it parses the provider body and
 * must re-query the provider before creating this value.
 */
export async function grantFincodeOneTimeVoicePurchase(input: {
  payment: VerifiedFincodeOneTimeVoicePayment;
  intents: FincodeOneTimeVoicePurchaseIntentPort;
  grants: FincodeOneTimeVoiceAtomicGrantPort;
  completedAt: string;
}): Promise<FincodeOneTimeVoiceGrantResult> {
  if (!isExactCapturedPayment(input.payment) || !Number.isFinite(Date.parse(input.completedAt))) return "REJECTED";

  let paymentDigest: string;
  let payloadFingerprint: string;
  try {
    paymentDigest = createFincodeOneTimeVoicePaymentDigest(input.payment);
    payloadFingerprint = createFincodeOneTimeVoicePayloadFingerprint(input.payment);
  } catch {
    return "REJECTED";
  }

  let purchase: FincodeOneTimeVoicePurchaseIntent | null;
  try {
    purchase = await input.intents.findByPaymentDigest(paymentDigest);
  } catch {
    return "RETRYABLE_FAILURE";
  }
  if (!isExactRegisteredIntent(purchase)) return "REJECTED";
  if (purchase.environment !== input.payment.environment || purchase.payloadFingerprint !== payloadFingerprint) {
    return "REJECTED";
  }
  if (purchase.state === "COMPLETED") return "ALREADY_COMPLETED";

  try {
    return await input.grants.grant({ purchase, completedAt: input.completedAt });
  } catch {
    return "RETRYABLE_FAILURE";
  }
}
