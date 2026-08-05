export type FincodeTestErrorCode =
  | "FINCODE_TEST_DISABLED"
  | "FINCODE_TEST_CONFIGURATION_INVALID"
  | "FINCODE_TEST_ENVIRONMENT_REJECTED"
  | "FINCODE_TEST_AUTH_REJECTED"
  | "FINCODE_TEST_REQUEST_INVALID"
  | "FINCODE_TEST_PAYMENT_REJECTED"
  | "FINCODE_TEST_PROVIDER_UNAVAILABLE"
  | "FINCODE_TEST_RESPONSE_INVALID";

export class FincodeTestError extends Error {
  readonly code: FincodeTestErrorCode;

  constructor(code: FincodeTestErrorCode) {
    super(code);
    this.name = "FincodeTestError";
    this.code = code;
  }
}

export function isFincodeTestError(value: unknown): value is FincodeTestError {
  return value instanceof FincodeTestError;
}
