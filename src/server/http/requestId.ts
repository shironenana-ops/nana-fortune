import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function createRequestId(candidate?: unknown): string {
  if (typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)) return candidate;
  return randomUUID();
}
