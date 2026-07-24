import { ServerFoundationError } from "../http/errors";

export type ReadingAsyncConfig = {
  jobsTable: string;
  jobTtlSeconds: number;
  lightLeaseSeconds: number;
  deepLeaseSeconds: number;
  orphanGraceSeconds: number;
};

function integer(value: string | undefined, min: number, max: number): number {
  if (!value || !/^\d+$/u.test(value)) throw new ServerFoundationError("READING_JOB_CONFIG_ERROR");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ServerFoundationError("READING_JOB_CONFIG_ERROR");
  return parsed;
}

export function readingAsyncPaidEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function readReadingAsyncConfig(env: NodeJS.ProcessEnv): ReadingAsyncConfig {
  const jobsTable = env.READING_JOBS_TABLE_NAME;
  if (!jobsTable || jobsTable.length > 255 || /[\r\n\0]/u.test(jobsTable)) throw new ServerFoundationError("READING_JOB_CONFIG_ERROR");
  return {
    jobsTable,
    jobTtlSeconds: integer(env.READING_JOB_TTL_SECONDS, 3600, 30 * 24 * 60 * 60),
    lightLeaseSeconds: integer(env.READING_LIGHT_JOB_LEASE_SECONDS, 60, 900),
    deepLeaseSeconds: integer(env.READING_DEEP_JOB_LEASE_SECONDS, 60, 900),
    orphanGraceSeconds: integer(env.READING_JOB_ORPHAN_GRACE_SECONDS, 30, 300),
  };
}
