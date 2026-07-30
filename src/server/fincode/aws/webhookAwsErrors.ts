export type FincodeWebhookAwsErrorCode =
  | "FINCODE_WEBHOOK_AWS_CONFIG_INVALID"
  | "FINCODE_WEBHOOK_LEDGER_UNAVAILABLE"
  | "FINCODE_WEBHOOK_CUSTOMER_MAPPING_UNAVAILABLE"
  | "FINCODE_WEBHOOK_SECRET_UNAVAILABLE";

export class FincodeWebhookAwsError extends Error {
  constructor(public readonly code: FincodeWebhookAwsErrorCode) {
    super(code);
    this.name = "FincodeWebhookAwsError";
  }
}
