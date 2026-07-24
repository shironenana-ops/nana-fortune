import { createHmac, randomUUID } from "node:crypto";
import { ServerFoundationError } from "../http/errors";
import type { ReadingJobQueue } from "./readingJobQueue";
import type {
  AsyncAcceptanceInput,
  AsyncPrecheckResult,
  AsyncReadingPersistence,
  QueuedReadingResponse,
  ReadingApiResult,
} from "./readingJobTypes";

export type ReadingAsyncAcceptance = {
  enqueue(params: Omit<AsyncAcceptanceInput, "ownerRef"> & { requestId: string }): Promise<ReadingApiResult>;
};

function ownerReference(userId: string, secret: string): string {
  if (!secret || secret.length < 32) throw new ServerFoundationError("AUDIT_NOT_CONFIGURED");
  return createHmac("sha256", secret).update(`shirone-reading-job-owner-v1\0${userId}`, "utf8").digest("hex");
}

function fromPrecheck(result: AsyncPrecheckResult, requestId: string): ReadingApiResult | undefined {
  if (result.kind === "queued" || result.kind === "in_progress") {
    return { request_id: requestId, reading_id: result.historyId, status: "queued" };
  }
  if (result.kind === "completed") return { ...result.history, request_id: requestId };
  if (result.kind === "failed") throw new ServerFoundationError("READING_JOB_FAILED");
  if (result.kind === "conflict") throw new ServerFoundationError("IDEMPOTENCY_CONFLICT");
  return undefined;
}

export function createReadingAsyncAcceptance(dependencies: {
  queue: ReadingJobQueue;
  persistence: AsyncReadingPersistence;
  auditHashSecret: string;
  uuid?: () => string;
}): ReadingAsyncAcceptance {
  const uuid = dependencies.uuid ?? randomUUID;
  return {
    async enqueue(params) {
      const existing = await dependencies.persistence.precheck(params);
      const replay = fromPrecheck(existing, params.requestId);
      if (replay) return replay;

      const jobRef = uuid();
      const historyId = uuid();
      if (jobRef === historyId) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
      await dependencies.queue.send(params.mode, jobRef);
      const accepted = await dependencies.persistence.accept({
        ...params,
        ownerRef: ownerReference(params.userId, dependencies.auditHashSecret),
        jobRef,
        historyId,
      });
      if (accepted === "accepted") {
        return { request_id: params.requestId, reading_id: historyId, status: "queued" } satisfies QueuedReadingResponse;
      }
      // A queue message without an accepted job is intentionally left for the
      // worker orphan protocol.  Re-read the winning transaction state.
      const concurrent = await dependencies.persistence.precheck(params);
      const concurrentReplay = fromPrecheck(concurrent, params.requestId);
      if (concurrentReplay) return concurrentReplay;
      throw new ServerFoundationError("READING_JOB_UNAVAILABLE");
    },
  };
}
