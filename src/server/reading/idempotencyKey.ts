import { ServerFoundationError } from "../http/errors";

export type ValidatedIdempotencyKey = string & { readonly __brand: "ValidatedIdempotencyKey" };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateIdempotencyKey(value: unknown): ValidatedIdempotencyKey {
  if (value === undefined || value === null || value === "") {
    throw new ServerFoundationError("IDEMPOTENCY_KEY_REQUIRED");
  }
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new ServerFoundationError("IDEMPOTENCY_KEY_INVALID");
  }
  return value as ValidatedIdempotencyKey;
}
