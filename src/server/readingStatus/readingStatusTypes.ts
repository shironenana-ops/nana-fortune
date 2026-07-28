import type { HeaderMap } from "../auth/sessionToken";
import type { PublicReadingResponse } from "../readingApi/readingApiTypes";
import type { ReadingJobState } from "../readingAsync/readingJobTypes";

export const READING_STATUS_API_PATH = "/reading/status";
export const READING_STATUS_API_ROUTE_KEY = `GET ${READING_STATUS_API_PATH}`;
export const READING_STATUS_API_OPTIONS_ROUTE_KEY = `OPTIONS ${READING_STATUS_API_PATH}`;
export const READING_STATUS_RETRY_AFTER_SECONDS = 3;

export type ReadingStatusApiRequest = {
  requestId: string;
  headers: HeaderMap;
  jobRef: string;
};

export type ReadingStatusRecord =
  | { state: "QUEUED" | "IN_PROGRESS" }
  | { state: "COMPLETED"; reading: Omit<PublicReadingResponse, "request_id"> }
  | { state: "FAILED" };

export interface ReadingStatusRepository {
  readOwned(params: { jobRef: string; userId: string; ownerRef: string }): Promise<ReadingStatusRecord | undefined>;
}

export type ReadingStatusResponse =
  | { request_id: string; job_ref: string; status: Extract<ReadingJobState, "QUEUED" | "IN_PROGRESS"> }
  | { request_id: string; job_ref: string; status: "COMPLETED"; reading: Omit<PublicReadingResponse, "request_id"> }
  | {
      request_id: string;
      job_ref: string;
      status: "FAILED";
      error: { code: "READING_JOB_FAILED"; message: string };
    };

export type ReadingStatusDependencies = {
  repository: ReadingStatusRepository;
  sessionSecret?: string;
  auditHashSecret?: string;
  auditSink?: (line: string) => void;
  now?: () => Date;
};
