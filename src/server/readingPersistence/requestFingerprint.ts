import { createHmac, timingSafeEqual } from "node:crypto";
import type { ValidatedReadingRequest } from "../reading/readingRequest";
import type { ValidatedIdempotencyKey } from "../reading/idempotencyKey";
import { ServerFoundationError } from "../http/errors";

const REF_DOMAIN = "shirone-reading-request-ref-v1\0";
const FINGERPRINT_DOMAIN = "shirone-reading-request-fingerprint-v1\0";

function secret(value?: string): string {
  if (!value || value.length < 32 || /[\r\n\0]/u.test(value)) throw new ServerFoundationError("PERSISTENCE_NOT_CONFIGURED");
  return value;
}
function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}
export function createReadingRequestRef(params: { userId: string; idempotencyKey: ValidatedIdempotencyKey; secret?: string }): string {
  return hmac(secret(params.secret), `${REF_DOMAIN}${params.userId}\0${params.idempotencyKey}`);
}
export function createReadingRequestFingerprint(params: { request: ValidatedReadingRequest; secret?: string }): string {
  const value = [
    "shirone-reading-api-v1",
    params.request.name,
    params.request.birthDate,
    params.request.question ?? "",
    params.request.requestedMode ?? "",
  ].map((item) => `${Buffer.byteLength(item, "utf8")}:${item}`).join("|");
  return hmac(secret(params.secret), `${FINGERPRINT_DOMAIN}${value}`);
}
export function fingerprintsEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
