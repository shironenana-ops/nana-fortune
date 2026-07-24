import { ServerFoundationError } from "../http/errors";
import { READING_JOB_MESSAGE_SCHEMA_VERSION, type PaidReadingMode } from "./readingJobTypes";

export type ReadingJobMessage = {
  schema_version: typeof READING_JOB_MESSAGE_SCHEMA_VERSION;
  job_ref: string;
};

export interface ReadingJobQueue {
  send(mode: PaidReadingMode, jobRef: string): Promise<void>;
}

export function serializeReadingJobMessage(jobRef: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(jobRef)) {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  return JSON.stringify({ schema_version: READING_JOB_MESSAGE_SCHEMA_VERSION, job_ref: jobRef });
}

export function parseReadingJobMessage(body: unknown): ReadingJobMessage {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 512) {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new ServerFoundationError("READING_JOB_INCONSISTENT"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "job_ref,schema_version" ||
      record.schema_version !== READING_JOB_MESSAGE_SCHEMA_VERSION || typeof record.job_ref !== "string") {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  serializeReadingJobMessage(record.job_ref);
  return record as ReadingJobMessage;
}
