import { createHmac, timingSafeEqual } from "node:crypto";
import { ServerFoundationError } from "../http/errors";

export function createReadingJobOwnerRef(userId: string, secret: string): string {
  if (!secret || secret.length < 32) throw new ServerFoundationError("AUDIT_NOT_CONFIGURED");
  return createHmac("sha256", secret)
    .update(`shirone-reading-job-owner-v1\0${userId}`, "utf8")
    .digest("hex");
}

export function readingJobOwnerRefsEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
