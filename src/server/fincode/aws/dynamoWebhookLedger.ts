import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { FincodeWebhookLedgerPort, FincodeWebhookLedgerReserveResult } from "../webhookPorts";
import { FincodeWebhookAwsError } from "./webhookAwsErrors";

type Sender = { send(command: unknown): Promise<unknown> };
type Item = Record<string, AttributeValue>;
const DIGEST = /^[0-9a-f]{64}$/u;
const RESULT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function conditional(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "ConditionalCheckFailedException";
}

function text(item: Item | undefined, key: string): string | undefined {
  return item?.[key] && "S" in item[key] ? item[key].S : undefined;
}

export class DynamoFincodeWebhookLedger implements FincodeWebhookLedgerPort {
  constructor(
    private readonly client: Sender,
    private readonly tableName: string,
    private readonly environment: "staging" | "production",
    private readonly now: () => number = Date.now,
  ) {}

  private async get(key: string): Promise<Item | undefined> {
    const result = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { event_digest: { S: key } },
      ConsistentRead: true,
    })) as { Item?: Item };
    return result.Item;
  }

  private classify(item: Item | undefined, fingerprint: string): FincodeWebhookLedgerReserveResult {
    if (!item || text(item, "payload_fingerprint") !== fingerprint || text(item, "environment") !== this.environment) return "CONFLICT";
    const state = text(item, "processing_state");
    if (state === "COMPLETED" || state === "MANUAL_REVIEW") return "DUPLICATE_COMPLETED";
    if (state === "RESERVED") return "DUPLICATE_IN_PROGRESS";
    return "UNAVAILABLE";
  }

  async reserve(input: { semanticEventKey: string; payloadFingerprint: string; ttlSeconds: number }): Promise<FincodeWebhookLedgerReserveResult> {
    if (!DIGEST.test(input.semanticEventKey) || !DIGEST.test(input.payloadFingerprint) ||
        !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) return "UNAVAILABLE";
    const now = this.now();
    const iso = new Date(now).toISOString();
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          event_digest: { S: input.semanticEventKey }, payload_fingerprint: { S: input.payloadFingerprint },
          environment: { S: this.environment }, processing_state: { S: "RESERVED" }, result_code: { S: "RESERVED" },
          attempt_count: { N: "1" }, version: { N: "1" }, created_at: { S: iso }, updated_at: { S: iso },
          expires_at: { N: String(Math.floor(now / 1000) + input.ttlSeconds) },
        },
        ConditionExpression: "attribute_not_exists(event_digest)",
      }));
      return "RESERVED";
    } catch (error) {
      if (!conditional(error)) return "UNAVAILABLE";
    }
    let existing: Item | undefined;
    try { existing = await this.get(input.semanticEventKey); } catch { return "UNAVAILABLE"; }
    if (text(existing, "processing_state") !== "FAILED_RETRYABLE") return this.classify(existing, input.payloadFingerprint);
    if (text(existing, "payload_fingerprint") !== input.payloadFingerprint || text(existing, "environment") !== this.environment) return "CONFLICT";
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { event_digest: { S: input.semanticEventKey } },
        UpdateExpression: "SET processing_state = :reserved, result_code = :code, updated_at = :now ADD attempt_count :one, version :one",
        ConditionExpression: "processing_state = :failed AND payload_fingerprint = :fingerprint AND environment = :environment",
        ExpressionAttributeValues: {
          ":reserved": { S: "RESERVED" }, ":code": { S: "RESERVED" }, ":now": { S: iso }, ":one": { N: "1" },
          ":failed": { S: "FAILED_RETRYABLE" }, ":fingerprint": { S: input.payloadFingerprint }, ":environment": { S: this.environment },
        },
      }));
      return "RESERVED";
    } catch (error) {
      if (!conditional(error)) return "UNAVAILABLE";
      try { return this.classify(await this.get(input.semanticEventKey), input.payloadFingerprint); } catch { return "UNAVAILABLE"; }
    }
  }

  async fail(input: { semanticEventKey: string; payloadFingerprint: string; retryableResultCode: string }): Promise<void> {
    if (!DIGEST.test(input.semanticEventKey) || !DIGEST.test(input.payloadFingerprint) || !RESULT_CODE.test(input.retryableResultCode)) {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_LEDGER_UNAVAILABLE");
    }
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { event_digest: { S: input.semanticEventKey } },
        UpdateExpression: "SET processing_state = :failed, result_code = :code, updated_at = :now ADD version :one",
        ConditionExpression: "processing_state = :reserved AND payload_fingerprint = :fingerprint AND environment = :environment",
        ExpressionAttributeValues: {
          ":failed": { S: "FAILED_RETRYABLE" }, ":code": { S: input.retryableResultCode },
          ":now": { S: new Date(this.now()).toISOString() }, ":one": { N: "1" }, ":reserved": { S: "RESERVED" },
          ":fingerprint": { S: input.payloadFingerprint }, ":environment": { S: this.environment },
        },
      }));
    } catch {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_LEDGER_UNAVAILABLE");
    }
  }
}
