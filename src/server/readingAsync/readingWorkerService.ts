import { randomUUID } from "node:crypto";
import type { ShironeEngineResult } from "../../lib/shironeEngine";
import { writeSafeAuditLog } from "../audit/safeAuditLog";
import { ServerFoundationError } from "../http/errors";
import { toPublicReadingResponse } from "../readingApi/readingApiResponse";
import type { RenderedReading } from "../reading/rendering/readingProseRenderer";
import { parseReadingJobMessage } from "./readingJobQueue";
import type { AsyncReadingPersistence, PaidReadingMode, ReadingJob } from "./readingJobTypes";

export type SqsRecord = {
  messageId?: unknown;
  body?: unknown;
  attributes?: unknown;
};
export type SqsEvent = { Records?: unknown };
export type SqsBatchResponse = { batchItemFailures: Array<{ itemIdentifier: string }> };

type WorkerDependencies = {
  persistence: AsyncReadingPersistence;
  engineRunner(input: { name: string; birthDate: string; question?: string; today: string; plan: PaidReadingMode }): ShironeEngineResult;
  renderReading(params: { requestId: string; displayName: string; question?: string; reading: ShironeEngineResult }): Promise<RenderedReading>;
  auditHashSecret?: string;
  auditSink?: (line: string) => void;
  clock: { now(): Date };
  orphanGraceSeconds: number;
  uuid?: () => string;
};

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\0]/u.test(value);
}

function sentTimestamp(record: SqsRecord): number | undefined {
  if (!record.attributes || typeof record.attributes !== "object" || Array.isArray(record.attributes)) return undefined;
  const value = (record.attributes as Record<string, unknown>).SentTimestamp;
  if (typeof value !== "string" || !/^\d{10,16}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function createReadingWorkerHandler(mode: PaidReadingMode, dependencies: WorkerDependencies) {
  const uuid = dependencies.uuid ?? randomUUID;
  const audit = (requestId: string, event: string, outcome: "success" | "denied" | "error", job?: ReadingJob, errorCode?: string) => {
    writeSafeAuditLog({
      event: { requestId, event, outcome, errorCode, resolvedMode: mode, attemptCount: job?.attemptCount },
      userId: job?.ownerUserId,
      auditHashSecret: dependencies.auditHashSecret,
      sink: dependencies.auditSink,
      now: dependencies.clock.now(),
    });
  };

  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    if (!Array.isArray(event?.Records)) return { batchItemFailures: [] };
    const failures: Array<{ itemIdentifier: string }> = [];
    for (const rawRecord of event.Records) {
      const record = rawRecord && typeof rawRecord === "object" && !Array.isArray(rawRecord) ? rawRecord as SqsRecord : {};
      const messageId = validMessageId(record.messageId) ? record.messageId : uuid();
      let message;
      try { message = parseReadingJobMessage(record.body); }
      catch { audit(messageId, "reading_job_message_discarded", "denied", undefined, "READING_JOB_INCONSISTENT"); continue; }

      let job: ReadingJob | undefined;
      try { job = await dependencies.persistence.readJob(message.job_ref); }
      catch { failures.push({ itemIdentifier: messageId }); continue; }
      if (!job) {
        const sent = sentTimestamp(record);
        const age = sent === undefined ? undefined : dependencies.clock.now().getTime() - sent;
        if (age === undefined || age < 0 || age < dependencies.orphanGraceSeconds * 1000) {
          failures.push({ itemIdentifier: messageId });
        } else {
          audit(messageId, "reading_orphan_message_discarded", "denied");
        }
        continue;
      }
      if (job.mode !== mode) { audit(messageId, "reading_job_mode_mismatch", "denied", job, "READING_JOB_INCONSISTENT"); continue; }
      if (job.state === "COMPLETED" || job.state === "FAILED") continue;

      // A prior delivery may have staged the allow-list result and then failed
      // its terminal transaction.  Finalize it without another engine/provider call.
      if (job.state === "IN_PROGRESS" && job.stagedResult) {
        try { await dependencies.persistence.complete({ job, now: dependencies.clock.now() }); audit(messageId, "reading_job_completed", "success", job); }
        catch { failures.push({ itemIdentifier: messageId }); }
        continue;
      }

      let claimed;
      try { claimed = await dependencies.persistence.claim({ job, workerMode: mode, leaseOwner: uuid(), now: dependencies.clock.now() }); }
      catch { failures.push({ itemIdentifier: messageId }); continue; }
      if (claimed.kind === "active") { audit(messageId, "reading_job_duplicate_active", "success", job); continue; }
      if (claimed.kind === "terminal" || claimed.kind === "mode_mismatch") continue;
      if (claimed.kind === "retry") { failures.push({ itemIdentifier: messageId }); continue; }

      let currentJob = claimed.job;
      audit(messageId, currentJob.attemptCount > 1 ? "reading_job_lease_reclaimed" : "reading_job_claimed", "success", currentJob);
      try {
        const canonical = dependencies.engineRunner({
          name: currentJob.canonicalInput.name,
          birthDate: currentJob.canonicalInput.birthDate,
          ...(currentJob.canonicalInput.question ? { question: currentJob.canonicalInput.question } : {}),
          today: currentJob.canonicalInput.readingDate,
          plan: mode,
        });
        const rendered = await dependencies.renderReading({ requestId: messageId, displayName: currentJob.canonicalInput.name, question: currentJob.canonicalInput.question, reading: canonical });
        const { request_id: _requestId, ...result } = toPublicReadingResponse(messageId, rendered);
        currentJob = await dependencies.persistence.stageResult({ job: currentJob, result, now: dependencies.clock.now() });
        await dependencies.persistence.complete({ job: currentJob, now: dependencies.clock.now() });
        audit(messageId, "reading_job_completed", "success", currentJob);
      } catch (error) {
        if (error instanceof ServerFoundationError && ["READING_JOB_UNAVAILABLE", "READING_RATE_LIMIT_UNAVAILABLE"].includes(error.code)) {
          if (!currentJob.stagedResult) {
            try {
              await dependencies.persistence.requeue({ job: currentJob, now: dependencies.clock.now() });
              audit(messageId, "reading_job_retry_scheduled", "error", currentJob, error.code);
            } catch {
              // Return the record as failed. Lease expiry remains the final
              // recovery boundary if the explicit requeue transaction failed.
            }
          }
          failures.push({ itemIdentifier: messageId });
          continue;
        }
        try {
          await dependencies.persistence.fail({ job: currentJob, category: "generation_failed", now: dependencies.clock.now() });
          audit(messageId, "reading_job_failed", "error", currentJob, "INTERNAL_ERROR");
        } catch {
          failures.push({ itemIdentifier: messageId });
        }
      }
    }
    return { batchItemFailures: failures };
  };
}
