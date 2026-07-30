import { createHash, timingSafeEqual } from "node:crypto";
import {
  FINCODE_SIGNATURE_HEADER,
  FincodeWebhookError,
  type FincodeWebhookHeaders,
} from "./webhookTypes";

function fixedDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function headerValues(headers: FincodeWebhookHeaders): string[] {
  const values: string[] = [];
  for (const [name, rawValue] of Object.entries(headers)) {
    if (name.toLowerCase() !== FINCODE_SIGNATURE_HEADER.toLowerCase() || rawValue === undefined) continue;
    if (Array.isArray(rawValue)) values.push(...rawValue);
    else values.push(rawValue as string);
  }
  return values;
}

export function verifyFincodeWebhookSignature(params: {
  headers: FincodeWebhookHeaders;
  expectedSignature?: string;
}): void {
  const expected = params.expectedSignature;
  if (!expected || /[\r\n\0]/u.test(expected)) {
    throw new FincodeWebhookError("WEBHOOK_SIGNATURE_NOT_CONFIGURED");
  }

  const values = headerValues(params.headers);
  if (values.length === 0 || values[0] === "") {
    throw new FincodeWebhookError("WEBHOOK_SIGNATURE_MISSING");
  }
  if (values.length !== 1 || values[0].includes(",") || /[\r\n\0]/u.test(values[0])) {
    throw new FincodeWebhookError("WEBHOOK_SIGNATURE_AMBIGUOUS");
  }

  const supplied = values[0];
  const equalDigest = timingSafeEqual(fixedDigest(supplied), fixedDigest(expected));
  const equalLength = Buffer.byteLength(supplied, "utf8") === Buffer.byteLength(expected, "utf8");
  if (!equalDigest || !equalLength) {
    throw new FincodeWebhookError("WEBHOOK_SIGNATURE_INVALID");
  }
}
