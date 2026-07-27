import { ServerFoundationError } from "../http/errors";

export type ReadingStatusConfig = {
  jobsTable: string;
  historyTable: string;
};

function tableName(value: string | undefined): string {
  if (!value || value.length > 255 || /[\r\n\0]/u.test(value)) {
    throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
  }
  return value;
}

export function readingStatusApiEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function readReadingStatusConfig(env: Record<string, string | undefined> = process.env): ReadingStatusConfig {
  return {
    jobsTable: tableName(env.READING_JOBS_TABLE_NAME),
    historyTable: tableName(env.READING_HISTORY_TABLE_NAME),
  };
}
