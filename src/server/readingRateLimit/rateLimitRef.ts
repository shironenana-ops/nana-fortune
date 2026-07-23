import { createHmac } from "node:crypto";
import type { MembershipTier, RateLimitReadingMode } from "./rateLimitPolicy";

function ref(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function createRateWindowRef(params: { userId: string; tier: MembershipTier; mode: RateLimitReadingMode; windowStart: number; secret: string }) {
  return ref(params.secret, `reading-rate-window-v1\0${params.userId}\0${params.tier}\0${params.mode}\0${params.windowStart}`);
}

export function createConcurrencyRef(params: { userId: string; mode: "light" | "deep"; secret: string }) {
  return ref(params.secret, `reading-concurrency-v1\0${params.userId}\0${params.mode}`);
}
