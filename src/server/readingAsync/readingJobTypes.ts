import type { PublicReadingResponse } from "../readingApi/readingApiTypes";
import type { MembershipTier } from "../readingRateLimit/rateLimitPolicy";

export const READING_JOB_SCHEMA_VERSION = "shirone-reading-job-v1" as const;
export const READING_JOB_MESSAGE_SCHEMA_VERSION = "shirone-reading-job-message-v1" as const;
export type PaidReadingMode = "light" | "deep";
export type ReadingJobState = "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export type CanonicalJobInput = {
  name: string;
  birthDate: string;
  question?: string;
  readingDate: string;
  resolvedMode: PaidReadingMode;
};

export type QueuedReadingResponse = {
  request_id: string;
  reading_id: string;
  status: "queued";
};

export type ReadingApiResult = PublicReadingResponse | QueuedReadingResponse;

export type ReadingJob = {
  jobRef: string;
  historyId: string;
  requestRef: string;
  fingerprint: string;
  mode: PaidReadingMode;
  state: ReadingJobState;
  version: number;
  ownerUserId: string;
  ownerRef: string;
  canonicalInput: CanonicalJobInput;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  concurrencyRef?: string;
  concurrencyReservationId?: string;
  concurrencyExpiresAt?: number;
  deepReservation?: {
    quotaRef: string;
    periodKey: string;
    reservationId: string;
    reservationExpiresAt: number;
  };
  stagedResult?: Omit<PublicReadingResponse, "request_id">;
  safeFailureCategory?: ReadingJobFailureCategory;
};

export type ReadingJobFailureCategory =
  | "generation_failed"
  | "job_inconsistent"
  | "mode_mismatch"
  | "configuration_error";

export type AsyncPrecheckResult =
  | { kind: "missing" }
  | { kind: "queued" | "in_progress"; historyId: string }
  | { kind: "completed"; history: Omit<PublicReadingResponse, "request_id"> }
  | { kind: "failed" }
  | { kind: "conflict" };

export type AsyncAcceptanceInput = {
  requestRef: string;
  fingerprint: string;
  userId: string;
  ownerRef: string;
  membershipTier: MembershipTier;
  mode: PaidReadingMode;
  canonicalInput: CanonicalJobInput;
  now: Date;
};

export interface AsyncReadingPersistence {
  precheck(params: Pick<AsyncAcceptanceInput, "requestRef" | "fingerprint" | "userId">): Promise<AsyncPrecheckResult>;
  accept(params: AsyncAcceptanceInput & { jobRef: string; historyId: string }): Promise<"accepted" | "conflict">;
  readJob(jobRef: string): Promise<ReadingJob | undefined>;
  claim(params: { job: ReadingJob; workerMode: PaidReadingMode; leaseOwner: string; now: Date }): Promise<
    | { kind: "claimed"; job: ReadingJob }
    | { kind: "active" }
    | { kind: "terminal" }
    | { kind: "mode_mismatch" }
    | { kind: "retry"; retryAfter?: number }
  >;
  stageResult(params: { job: ReadingJob; result: Omit<PublicReadingResponse, "request_id">; now: Date }): Promise<ReadingJob>;
  complete(params: { job: ReadingJob; now: Date }): Promise<void>;
  fail(params: { job: ReadingJob; category: ReadingJobFailureCategory; now: Date }): Promise<void>;
  requeue(params: { job: ReadingJob; now: Date }): Promise<void>;
}
