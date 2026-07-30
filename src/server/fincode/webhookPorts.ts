import type { FincodeTransitionDecision } from "./webhookTypes";

export const FINCODE_WEBHOOK_LEDGER_RESERVE_RESULTS = [
  "RESERVED",
  "DUPLICATE_COMPLETED",
  "DUPLICATE_IN_PROGRESS",
  "CONFLICT",
  "UNAVAILABLE",
] as const;

export type FincodeWebhookLedgerReserveResult = typeof FINCODE_WEBHOOK_LEDGER_RESERVE_RESULTS[number];

export type FincodeWebhookDigestIdentity = {
  semanticEventKey: string;
  payloadFingerprint: string;
};

export interface FincodeWebhookLedgerPort {
  reserve(input: FincodeWebhookDigestIdentity & { ttlSeconds: number }): Promise<FincodeWebhookLedgerReserveResult>;
  complete(input: FincodeWebhookDigestIdentity & { resultCode: string }): Promise<void>;
  fail(input: FincodeWebhookDigestIdentity & { retryableResultCode: string }): Promise<void>;
}

export interface FincodeWebhookCustomerPort {
  findByOpaqueCustomerReference(customerReference: string): Promise<{ userReference: string } | null>;
}

export interface FincodeWebhookEntitlementWriterPort {
  applyDecision(input: {
    userReference: string;
    semanticEventKey: string;
    decision: FincodeTransitionDecision;
  }): Promise<void>;
}

export type FincodeWebhookRetentionPolicy = {
  ttlSeconds: number;
  minimumTtlSeconds: number;
  maximumTtlSeconds: number;
};

export function validateFincodeWebhookRetentionPolicy(policy: FincodeWebhookRetentionPolicy): number {
  const values = [policy.ttlSeconds, policy.minimumTtlSeconds, policy.maximumTtlSeconds];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0) ||
      policy.minimumTtlSeconds > policy.maximumTtlSeconds ||
      policy.ttlSeconds < policy.minimumTtlSeconds || policy.ttlSeconds > policy.maximumTtlSeconds) {
    throw new Error("FINCODE_WEBHOOK_RETENTION_INVALID");
  }
  return policy.ttlSeconds;
}
