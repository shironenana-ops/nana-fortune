import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import type { PublicReadingResponse } from "../readingApi/readingApiTypes";
import { READING_JOB_SCHEMA_VERSION, type PaidReadingMode, type ReadingJobState } from "../readingAsync/readingJobTypes";
import { readingJobOwnerRefsEqual } from "../readingAsync/readingJobOwnerRef";
import type { ReadingStatusConfig } from "./readingStatusConfig";
import type { ReadingStatusRecord, ReadingStatusRepository } from "./readingStatusTypes";

type Item = Record<string, AttributeValue>;
type Sender = { send(command: GetItemCommand): Promise<{ Item?: Item }> };
const S = (value: string): AttributeValue => ({ S: value });
const text = (item: Item, key: string): string => item[key] && "S" in item[key] ? item[key].S ?? "" : "";
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

function parsePublicReading(value: string, expectedMode: PaidReadingMode): Omit<PublicReadingResponse, "request_id"> {
  if (!value || Buffer.byteLength(value, "utf8") > 300_000) throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ServerFoundationError("READING_STATUS_UNAVAILABLE"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
  const root = parsed as Record<string, unknown>;
  if (!exactKeys(root, ["rendering_status", "resolved_mode", "result", "status"]) ||
      root.status !== "completed" || root.resolved_mode !== expectedMode ||
      !["canonical", "rendered", "fallback"].includes(String(root.rendering_status)) ||
      !root.result || typeof root.result !== "object" || Array.isArray(root.result)) {
    throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
  }
  const result = root.result as Record<string, unknown>;
  if (!exactKeys(result, ["avoid_hint", "one_step", "sections", "title"]) ||
      !safeText(result.title, 500) || !safeText(result.one_step, 5_000) || !safeText(result.avoid_hint, 5_000) ||
      !Array.isArray(result.sections) || result.sections.length < 1 || result.sections.length > 20) {
    throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
  }
  for (const section of result.sections) {
    if (!section || typeof section !== "object" || Array.isArray(section)) throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
    const item = section as Record<string, unknown>;
    if (!exactKeys(item, ["body", "heading", "id"]) || !safeText(item.id, 64) || !safeText(item.heading, 200) || !safeText(item.body, 50_000)) {
      throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
    }
  }
  return parsed as Omit<PublicReadingResponse, "request_id">;
}

export class DynamoReadingStatusRepository implements ReadingStatusRepository {
  constructor(private sender: Sender, private config: ReadingStatusConfig) {}

  private async get(tableName: string, key: Item, projection: string, names?: Record<string, string>): Promise<Item | undefined> {
    try {
      return (await this.sender.send(new GetItemCommand({
        TableName: tableName,
        Key: key,
        ConsistentRead: true,
        ProjectionExpression: projection,
        ...(names ? { ExpressionAttributeNames: names } : {}),
      }))).Item;
    } catch (error) {
      throw new ServerFoundationError("READING_STATUS_UNAVAILABLE", { cause: error });
    }
  }

  async readOwned(params: { jobRef: string; userId: string; ownerRef: string }): Promise<ReadingStatusRecord | undefined> {
    const job = await this.get(
      this.config.jobsTable,
      { job_ref: S(params.jobRef) },
      "schema_version, owner_ref, #state, history_id, #mode",
      { "#state": "state", "#mode": "mode" },
    );
    if (!job) return undefined;
    const storedOwnerRef = text(job, "owner_ref");
    if (!readingJobOwnerRefsEqual(storedOwnerRef, params.ownerRef)) return undefined;

    const state = text(job, "state") as ReadingJobState;
    const mode = text(job, "mode") as PaidReadingMode;
    const historyId = text(job, "history_id");
    if (text(job, "schema_version") !== READING_JOB_SCHEMA_VERSION ||
        !["QUEUED", "IN_PROGRESS", "COMPLETED", "FAILED"].includes(state) ||
        (mode !== "light" && mode !== "deep") || !historyId) {
      throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
    }
    if (state !== "COMPLETED") return { state };

    const history = await this.get(
      this.config.historyTable,
      { user_id: S(params.userId), history_id: S(historyId) },
      "schema_version, #status, resolved_mode, public_result",
      { "#status": "status" },
    );
    if (!history || text(history, "schema_version") !== "shirone-reading-history-v1" ||
        text(history, "status") !== "completed" || text(history, "resolved_mode") !== mode) {
      throw new ServerFoundationError("READING_STATUS_UNAVAILABLE");
    }
    return { state, reading: parsePublicReading(text(history, "public_result"), mode) };
  }
}

export function createDynamoReadingStatusRepository(config: ReadingStatusConfig): ReadingStatusRepository {
  return new DynamoReadingStatusRepository(new DynamoDBClient({ maxAttempts: 1 }), config);
}
