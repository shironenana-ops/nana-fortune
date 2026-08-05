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
const RESERVATION_LEASE_SECONDS = 300;
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function conditional(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "ConditionalCheckFailedException";
}

function text(item: Item | undefined, key: string): string | undefined {
  return item?.[key] && "S" in item[key] ? item[key].S : undefined;
}

function integer(item: Item | undefined, key: string): number | undefined {
  const value = item?.[key];
  if (!value || !("N" in value) || !/^\d+$/u.test(value.N ?? "")) return undefined;
  const parsed = Number(value.N);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

  private reclaimCondition(item: Item, now: number): { expression: string; values: Record<string, AttributeValue> } | null {
    if (text(item, "processing_state") !== "RESERVED" || text(item, "result_code") !== "RESERVED" ||
        item.completed_at !== undefined || item.mapped_user_digest !== undefined) return null;
    const nowEpoch = Math.floor(now / 1000);
    const leaseExpiresAt = integer(item, "reservation_expires_at");
    if (leaseExpiresAt !== undefined) {
      if (leaseExpiresAt > nowEpoch) return null;
      return {
        expression: "reservation_expires_at = :previousLease AND reservation_expires_at <= :epoch",
        values: { ":previousLease": { N: String(leaseExpiresAt) }, ":epoch": { N: String(nowEpoch) } },
      };
    }
    const updatedAt = text(item, "updated_at");
    if (!updatedAt || !STRICT_ISO.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt)) ||
        Date.parse(updatedAt) + RESERVATION_LEASE_SECONDS * 1000 > now) return null;
    return {
      expression: "attribute_not_exists(reservation_expires_at) AND updated_at = :previousUpdatedAt",
      values: { ":previousUpdatedAt": { S: updatedAt } },
    };
  }

  private async reclaimReserved(
    key: string,
    fingerprint: string,
    item: Item,
    now: number,
    ttlSeconds: number,
  ): Promise<FincodeWebhookLedgerReserveResult | null> {
    const reclaim = this.reclaimCondition(item, now);
    if (!reclaim) return null;
    const iso = new Date(now).toISOString();
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { event_digest: { S: key } },
        UpdateExpression: "SET processing_state = :reserved, result_code = :reserved, updated_at = :now, reservation_expires_at = :lease ADD attempt_count :one, version :one",
        ConditionExpression: `processing_state = :reserved AND result_code = :reserved AND payload_fingerprint = :fingerprint AND environment = :environment AND attribute_not_exists(completed_at) AND attribute_not_exists(mapped_user_digest) AND ${reclaim.expression}`,
        ExpressionAttributeValues: {
          ":reserved": { S: "RESERVED" }, ":now": { S: iso },
          ":lease": { N: String(Math.floor(now / 1000) + Math.min(RESERVATION_LEASE_SECONDS, ttlSeconds)) }, ":one": { N: "1" },
          ":fingerprint": { S: fingerprint }, ":environment": { S: this.environment }, ...reclaim.values,
        },
      }));
      return "RESERVED";
    } catch (error) {
      if (!conditional(error)) return "UNAVAILABLE";
      try { return this.classify(await this.get(key), fingerprint); } catch { return "UNAVAILABLE"; }
    }
  }

  async reserve(input: { semanticEventKey: string; payloadFingerprint: string; ttlSeconds: number }): Promise<FincodeWebhookLedgerReserveResult> {
    if (!DIGEST.test(input.semanticEventKey) || !DIGEST.test(input.payloadFingerprint) ||
        !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) return "UNAVAILABLE";
    const now = this.now();
    const iso = new Date(now).toISOString();
    const reservationExpiresAt = Math.floor(now / 1000) + Math.min(RESERVATION_LEASE_SECONDS, input.ttlSeconds);
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          event_digest: { S: input.semanticEventKey }, payload_fingerprint: { S: input.payloadFingerprint },
          environment: { S: this.environment }, processing_state: { S: "RESERVED" }, result_code: { S: "RESERVED" },
          attempt_count: { N: "1" }, version: { N: "1" }, created_at: { S: iso }, updated_at: { S: iso },
          reservation_expires_at: { N: String(reservationExpiresAt) },
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
    if (text(existing, "processing_state") === "RESERVED" && existing) {
      if (text(existing, "payload_fingerprint") !== input.payloadFingerprint || text(existing, "environment") !== this.environment) return "CONFLICT";
      const reclaimed = await this.reclaimReserved(input.semanticEventKey, input.payloadFingerprint, existing, now, input.ttlSeconds);
      return reclaimed ?? this.classify(existing, input.payloadFingerprint);
    }
    if (text(existing, "processing_state") !== "FAILED_RETRYABLE") return this.classify(existing, input.payloadFingerprint);
    if (text(existing, "payload_fingerprint") !== input.payloadFingerprint || text(existing, "environment") !== this.environment) return "CONFLICT";
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { event_digest: { S: input.semanticEventKey } },
        UpdateExpression: "SET processing_state = :reserved, result_code = :code, updated_at = :now, reservation_expires_at = :lease ADD attempt_count :one, version :one",
        ConditionExpression: "processing_state = :failed AND payload_fingerprint = :fingerprint AND environment = :environment",
        ExpressionAttributeValues: {
          ":reserved": { S: "RESERVED" }, ":code": { S: "RESERVED" }, ":now": { S: iso },
          ":lease": { N: String(reservationExpiresAt) }, ":one": { N: "1" },
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
