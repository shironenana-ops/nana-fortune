import { authenticateHeaders } from "../auth/sessionToken";
import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { ServerFoundationError } from "../http/errors";
import { createReadingJobOwnerRef } from "../readingAsync/readingJobOwnerRef";
import type { ReadingStatusApiRequest, ReadingStatusDependencies, ReadingStatusResponse } from "./readingStatusTypes";

export const READING_JOB_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FAILED_MESSAGE = "鑑定を完了できませんでした。時間をおいて、あらためてお試しください。";

export async function executeReadingStatus(
  request: ReadingStatusApiRequest,
  dependencies: ReadingStatusDependencies,
): Promise<ReadingStatusResponse> {
  if (!READING_JOB_REF_PATTERN.test(request.jobRef)) {
    throw new ServerFoundationError("READING_STATUS_REF_INVALID");
  }
  const now = dependencies.now?.() ?? new Date();
  const session = authenticateHeaders({
    headers: request.headers,
    secret: dependencies.sessionSecret,
    nowEpochSeconds: Math.floor(now.getTime() / 1000),
  });
  const ownerRef = createReadingJobOwnerRef(session.user_id, dependencies.auditHashSecret ?? "");
  const record = await dependencies.repository.readOwned({
    jobRef: request.jobRef,
    userId: session.user_id,
    ownerRef,
  });
  if (!record) throw new ServerFoundationError("READING_STATUS_NOT_FOUND");

  writeSafeAuditLog({
    event: { requestId: request.requestId, event: "reading_status_read", outcome: "success" },
    userId: session.user_id,
    auditHashSecret: dependencies.auditHashSecret,
    sink: dependencies.auditSink,
    now,
  });

  if (record.state === "COMPLETED") {
    return { request_id: request.requestId, job_ref: request.jobRef, status: record.state, reading: record.reading };
  }
  if (record.state === "FAILED") {
    return {
      request_id: request.requestId,
      job_ref: request.jobRef,
      status: record.state,
      error: { code: "READING_JOB_FAILED", message: FAILED_MESSAGE },
    };
  }
  return { request_id: request.requestId, job_ref: request.jobRef, status: record.state };
}
