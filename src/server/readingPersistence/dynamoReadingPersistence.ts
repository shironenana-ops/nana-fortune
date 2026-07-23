import { createHash, randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import {
  calculateDeepRemaining,
  createDeepQuotaRef,
  DEEP_QUOTA_SCHEMA_VERSION,
  getJstPeriodKey,
  PREMIUM_DEEP_MONTHLY_LIMIT,
} from "./deepQuota";
import { fingerprintsEqual } from "./requestFingerprint";
import type { BeginResult, DeepReservation, ReadingPersistence, Reservation, StoredReading } from "./readingPersistence";
import type { ReadingPersistenceConfig } from "./persistenceConfig";
import { DynamoReadingRateLimiter } from "../readingRateLimit/dynamoReadingRateLimiter";
import type { MembershipTier } from "../readingRateLimit/rateLimitPolicy";

type Sender = { send(command: GetItemCommand | PutItemCommand | UpdateItemCommand | TransactWriteItemsCommand): Promise<any> };
type Item = Record<string, AttributeValue>;
type QuotaReservation = {
  reservationId: string;
  requestRef: string;
  historyId: string;
  reservedAt: string;
  expiresAt: number;
};
type QuotaItem = {
  quotaRef: string;
  periodKey: string;
  used: number;
  reservations: QuotaReservation[];
  version: number;
  createdAt: string;
};
const MAX_QUOTA_ATTEMPTS = 4;

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const B = (value: boolean): AttributeValue => ({ BOOL: value });
const text = (item: Item, key: string): string => {
  const value = item[key];
  return value && "S" in value ? value.S ?? "" : "";
};
const number = (item: Item, key: string): number => {
  const value = item[key];
  return value && "N" in value ? Number(value.N) : Number.NaN;
};

function conditional(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}

function transactionReason(error: unknown, index: number): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.[index]?.Code;
}

function safeStored(item?: Item): StoredReading {
  if (!item || text(item, "schema_version") !== "shirone-reading-history-v1" || text(item, "status") !== "completed") {
    throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text(item, "public_result")); } catch { throw new ServerFoundationError("HISTORY_UNAVAILABLE"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  const value = parsed as Record<string, unknown>;
  if (value.status !== "completed" || !value.result || typeof value.result !== "object") throw new ServerFoundationError("HISTORY_UNAVAILABLE");
  return {
    history_id: text(item, "history_id"),
    created_at: text(item, "created_at"),
    resolved_mode: text(item, "resolved_mode") as StoredReading["resolved_mode"],
    status: "completed",
    rendering_status: value.rendering_status as StoredReading["rendering_status"],
    result: value.result as StoredReading["result"],
  };
}

function reservationFromAttribute(value: AttributeValue): QuotaReservation {
  if (!("M" in value) || !value.M) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
  const item = value.M;
  const reservation = {
    reservationId: text(item, "reservation_id"),
    requestRef: text(item, "request_ref"),
    historyId: text(item, "history_id"),
    reservedAt: text(item, "reserved_at"),
    expiresAt: number(item, "reservation_expires_at"),
  };
  if (!reservation.reservationId || !/^[0-9a-f]{64}$/u.test(reservation.requestRef) || !reservation.historyId ||
      !reservation.reservedAt || !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= 0) {
    throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
  }
  return reservation;
}

function parseQuota(item: Item | undefined, quotaRef: string, periodKey: string): QuotaItem | undefined {
  if (!item) return undefined;
  const reservationsValue = item.reservations;
  if (text(item, "quota_ref") !== quotaRef || text(item, "schema_version") !== DEEP_QUOTA_SCHEMA_VERSION ||
      text(item, "period_key") !== periodKey || number(item, "limit") !== PREMIUM_DEEP_MONTHLY_LIMIT ||
      !reservationsValue || !("L" in reservationsValue) || !reservationsValue.L) {
    throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
  }
  const used = number(item, "used");
  const version = number(item, "version");
  const reservations = reservationsValue.L.map(reservationFromAttribute);
  if (!Number.isSafeInteger(used) || used < 0 || used > PREMIUM_DEEP_MONTHLY_LIMIT ||
      !Number.isSafeInteger(version) || version < 1 || reservations.length > PREMIUM_DEEP_MONTHLY_LIMIT ||
      new Set(reservations.map((value) => value.reservationId)).size !== reservations.length ||
      used + reservations.length > PREMIUM_DEEP_MONTHLY_LIMIT) {
    throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
  }
  return { quotaRef, periodKey, used, reservations, version, createdAt: text(item, "created_at") };
}

function quotaAttribute(item: QuotaItem, now: Date): Item {
  return {
    quota_ref: S(item.quotaRef),
    schema_version: S(DEEP_QUOTA_SCHEMA_VERSION),
    period_key: S(item.periodKey),
    limit: N(PREMIUM_DEEP_MONTHLY_LIMIT),
    used: N(item.used),
    reservations: { L: item.reservations.map((reservation) => ({ M: {
      reservation_id: S(reservation.reservationId),
      request_ref: S(reservation.requestRef),
      history_id: S(reservation.historyId),
      reserved_at: S(reservation.reservedAt),
      reservation_expires_at: N(reservation.expiresAt),
    } })) },
    version: N(item.version),
    created_at: S(item.createdAt),
    updated_at: S(now.toISOString()),
  };
}

function quotaPut(tableName: string, previous: QuotaItem | undefined, next: QuotaItem, now: Date): TransactWriteItem {
  return { Put: {
    TableName: tableName,
    Item: quotaAttribute(next, now),
    ConditionExpression: previous
      ? "#version=:version AND schema_version=:schema AND period_key=:period"
      : "attribute_not_exists(quota_ref)",
    ...(previous ? {
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: {
        ":version": N(previous.version),
        ":schema": S(DEEP_QUOTA_SCHEMA_VERSION),
        ":period": S(previous.periodKey),
      },
    } : {}),
  } };
}

function phaseToken(phase: string, reservation: Reservation, discriminator = ""): string {
  return createHash("sha256").update(`${phase}\0${reservation.requestRef}\0${reservation.ownerToken}\0${discriminator}`, "utf8").digest("hex").slice(0, 36);
}

export class DynamoReadingPersistence implements ReadingPersistence {
  private readonly rateLimiter?: DynamoReadingRateLimiter;
  constructor(
    private readonly sender: Sender,
    private readonly config: ReadingPersistenceConfig,
    private readonly uuid: () => string = randomUUID,
  ) { if (config.rateLimit) this.rateLimiter = new DynamoReadingRateLimiter(sender, config.rateLimit); }

  private reservation(params: { requestRef: string; fingerprint: string; resolvedMode: Reservation["resolvedMode"]; readingDate: string; now: Date }): Reservation {
    return {
      requestRef: params.requestRef,
      fingerprint: params.fingerprint,
      ownerToken: this.uuid(),
      historyId: this.uuid(),
      readingDate: params.readingDate,
      resolvedMode: params.resolvedMode,
      createdAt: params.now.toISOString(),
    };
  }

  private idempotencyItem(reservation: Reservation, now: Date): Item {
    const epoch = Math.floor(now.getTime() / 1000);
    return {
      request_ref: S(reservation.requestRef),
      schema_version: S("shirone-reading-idempotency-v1"),
      fingerprint: S(reservation.fingerprint),
      state: S("IN_PROGRESS"),
      owner_token: S(reservation.ownerToken),
      history_id: S(reservation.historyId),
      resolved_mode: S(reservation.resolvedMode),
      reading_date: S(reservation.readingDate),
      created_at: S(reservation.createdAt),
      updated_at: S(now.toISOString()),
      lease_expires_at: N(epoch + this.config.leaseSeconds),
      expires_at: N(epoch + this.config.ttlSeconds),
      ...(reservation.deep ? {
        deep_quota_schema_version: S(DEEP_QUOTA_SCHEMA_VERSION),
        deep_period_key: S(reservation.deep.periodKey),
        deep_reservation_id: S(reservation.deep.reservationId),
        deep_reservation_state: S("RESERVED"),
        deep_reservation_expires_at: N(reservation.deep.reservationExpiresAt),
      } : {}),
      ...(reservation.rateControl?.concurrencyRef ? {
        concurrency_schema_version: S("shirone-reading-concurrency-v1"),
        concurrency_ref: S(reservation.rateControl.concurrencyRef),
        concurrency_reservation_id: S(reservation.rateControl.concurrencyReservationId!),
        concurrency_expires_at: N(reservation.rateControl.concurrencyExpiresAt!),
      } : {}),
    };
  }

  private async readIdempotency(requestRef: string): Promise<Item | undefined> {
    try {
      return (await this.sender.send(new GetItemCommand({
        TableName: this.config.idempotencyTable,
        Key: { request_ref: S(requestRef) },
        ConsistentRead: true,
      }))).Item;
    } catch (error) {
      throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE", { cause: error });
    }
  }

  private async readHistory(userId: string, historyId: string): Promise<StoredReading> {
    try {
      const result = await this.sender.send(new GetItemCommand({
        TableName: this.config.historyTable,
        Key: { user_id: S(userId), history_id: S(historyId) },
        ConsistentRead: true,
      }));
      return safeStored(result.Item);
    } catch (error) {
      if (error instanceof ServerFoundationError) throw error;
      throw new ServerFoundationError("HISTORY_UNAVAILABLE", { cause: error });
    }
  }

  private async concurrencyRelease(reservation: Reservation, now: Date): Promise<TransactWriteItem | undefined> {
    if (!reservation.rateControl) return undefined;
    if (!this.rateLimiter) throw new ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED");
    return this.rateLimiter.prepareRelease(reservation.rateControl, reservation.requestRef, now);
  }

  private async classifyExisting(params: {
    existing: Item;
    requestRef: string;
    fingerprint: string;
    userId: string;
    now: Date;
  }): Promise<BeginResult | "reclaim"> {
    if (!fingerprintsEqual(text(params.existing, "fingerprint"), params.fingerprint)) return { kind: "conflict" };
    if (text(params.existing, "state") === "COMPLETED") {
      return { kind: "replay", history: await this.readHistory(params.userId, text(params.existing, "history_id")) };
    }
    const now = Math.floor(params.now.getTime() / 1000);
    const reclaim = text(params.existing, "state") === "FAILED" || number(params.existing, "lease_expires_at") <= now || number(params.existing, "expires_at") <= now;
    return reclaim ? "reclaim" : { kind: "in_progress" };
  }

  private async readQuota(quotaRef: string, periodKey: string): Promise<QuotaItem | undefined> {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    try {
      const result = await this.sender.send(new GetItemCommand({
        TableName: deep.tableName,
        Key: { quota_ref: S(quotaRef) },
        ConsistentRead: true,
      }));
      return parseQuota(result.Item, quotaRef, periodKey);
    } catch (error) {
      if (error instanceof ServerFoundationError) throw error;
      throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
    }
  }

  private usersCondition(userId: string): TransactWriteItem {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    return { ConditionCheck: {
      TableName: deep.usersTableName,
      Key: { user_id: S(userId) },
      ConditionExpression: "#plan=:premium AND subscription_status=:active AND deep_enabled=:enabled",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: { ":premium": S("premium"), ":active": S("active"), ":enabled": B(true) },
    } };
  }

  private async isStillDeepEntitled(userId: string): Promise<boolean> {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    try {
      const result = await this.sender.send(new GetItemCommand({
        TableName: deep.usersTableName,
        Key: { user_id: S(userId) },
        ProjectionExpression: "#plan, subscription_status, deep_enabled",
        ExpressionAttributeNames: { "#plan": "plan" },
        ConsistentRead: true,
      }));
      return result.Item?.plan?.S === "premium" && result.Item?.subscription_status?.S === "active" && result.Item?.deep_enabled?.BOOL === true;
    } catch (error) {
      throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
    }
  }

  private deepReservation(reservation: Reservation, userId: string, now: Date): DeepReservation {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    const periodKey = getJstPeriodKey(now);
    return {
      quotaRef: createDeepQuotaRef({ userId, periodKey, secret: deep.hashSecret }),
      periodKey,
      reservationId: this.uuid(),
      reservationExpiresAt: Math.floor(now.getTime() / 1000) + deep.reservationSeconds,
    };
  }

  private async reserveDeep(params: {
    reservation: Reservation;
    userId: string;
    membershipTier: MembershipTier;
    now: Date;
    existing?: Item;
  }): Promise<BeginResult> {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    const baseDeep = this.deepReservation(params.reservation, params.userId, params.now);
    const reservation = { ...params.reservation, deep: baseDeep };
    const nowEpoch = Math.floor(params.now.getTime() / 1000);

    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt += 1) {
      const previous = await this.readQuota(baseDeep.quotaRef, baseDeep.periodKey);
      const active = previous?.reservations.filter((value) => value.expiresAt > nowEpoch) ?? [];
      const expired = previous?.reservations.filter((value) => value.expiresAt <= nowEpoch) ?? [];
      const existingReservationId = params.existing ? text(params.existing, "deep_reservation_id") : "";
      const reusable = active.find((value) => value.requestRef === reservation.requestRef && value.reservationId === existingReservationId);

      if (reusable && params.existing && number(params.existing, "lease_expires_at") <= nowEpoch) {
        reservation.deep = {
          quotaRef: baseDeep.quotaRef,
          periodKey: baseDeep.periodKey,
          reservationId: reusable.reservationId,
          reservationExpiresAt: reusable.expiresAt,
        };
        const acquired = this.rateLimiter
          ? await this.rateLimiter.prepareAcquire({ userId: params.userId, tier: params.membershipTier, mode: "deep", requestRef: reservation.requestRef, ownerToken: reservation.ownerToken, now: params.now })
          : undefined;
        if (acquired) reservation.rateControl = acquired.reservation;
        try {
          await this.sender.send(new TransactWriteItemsCommand({ TransactItems: [
            this.usersCondition(params.userId),
            ...(acquired?.actions ?? []),
            { ConditionCheck: {
              TableName: deep.tableName,
              Key: { quota_ref: S(baseDeep.quotaRef) },
              ConditionExpression: `#version=:version AND reservations[${previous!.reservations.indexOf(reusable)}].reservation_id=:reservation`,
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":version": N(previous!.version), ":reservation": S(reusable.reservationId) },
            } },
            { Update: this.takeoverUpdate(params.existing, reservation, params.now) },
          ], ClientRequestToken: phaseToken("deep-takeover", reservation, String(previous!.version)) }));
          return { kind: "acquired", reservation, takeover: true };
        } catch (error) {
          if (!conditional(error)) throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
          if (transactionReason(error, 0) === "ConditionalCheckFailed" || !(await this.isStillDeepEntitled(params.userId))) throw new ServerFoundationError("READING_DEEP_NOT_ENTITLED");
          continue;
        }
      }

      const withoutSameRequest = active.filter((value) => value.requestRef !== reservation.requestRef);
      if (calculateDeepRemaining({ used: previous?.used ?? 0, activeReservations: withoutSameRequest.length }) <= 0) {
        throw new ServerFoundationError("READING_DEEP_MONTHLY_LIMIT_REACHED");
      }
      const acquired = this.rateLimiter
        ? await this.rateLimiter.prepareAcquire({ userId: params.userId, tier: params.membershipTier, mode: "deep", requestRef: reservation.requestRef, ownerToken: reservation.ownerToken, now: params.now })
        : undefined;
      if (acquired) reservation.rateControl = acquired.reservation;
      const nextReservation: QuotaReservation = {
        reservationId: baseDeep.reservationId,
        requestRef: reservation.requestRef,
        historyId: reservation.historyId,
        reservedAt: params.now.toISOString(),
        expiresAt: baseDeep.reservationExpiresAt,
      };
      const next: QuotaItem = {
        quotaRef: baseDeep.quotaRef,
        periodKey: baseDeep.periodKey,
        used: previous?.used ?? 0,
        reservations: [...withoutSameRequest, nextReservation],
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt || params.now.toISOString(),
      };
      const expiredUpdates: TransactWriteItem[] = [];
      for (const value of expired) {
        const idempotency = await this.readIdempotency(value.requestRef);
        if (!idempotency || text(idempotency, "state") !== "IN_PROGRESS" ||
            text(idempotency, "deep_reservation_state") !== "RESERVED" ||
            text(idempotency, "deep_reservation_id") !== value.reservationId) {
          throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
        }
        expiredUpdates.push({ Update: {
          TableName: this.config.idempotencyTable,
          Key: { request_ref: S(value.requestRef) },
          UpdateExpression: "SET #state=:failed, deep_reservation_state=:released, failure_category=:category, failed_at=:now, updated_at=:now REMOVE owner_token",
          ConditionExpression: "#state=:progress AND deep_reservation_state=:reserved AND deep_reservation_id=:reservation AND deep_reservation_expires_at<=:epoch",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":failed": S("FAILED"), ":progress": S("IN_PROGRESS"), ":released": S("RELEASED_EXPIRED"),
            ":reserved": S("RESERVED"), ":category": S("deep_reservation_expired"),
            ":now": S(params.now.toISOString()), ":epoch": N(nowEpoch), ":reservation": S(value.reservationId),
          },
        } });
      }
      const idempotencyAction: TransactWriteItem = params.existing
        ? { Update: this.retryUpdate(params.existing, reservation, params.now) }
        : { Put: { TableName: this.config.idempotencyTable, Item: this.idempotencyItem(reservation, params.now), ConditionExpression: "attribute_not_exists(request_ref)" } };
      try {
        await this.sender.send(new TransactWriteItemsCommand({
          TransactItems: [this.usersCondition(params.userId), ...(acquired?.actions ?? []), quotaPut(deep.tableName, previous, next, params.now), ...expiredUpdates, idempotencyAction],
          ClientRequestToken: phaseToken(params.existing ? "deep-retry" : "deep-reserve", reservation, String(previous?.version ?? 0)),
        }));
        return { kind: "acquired", reservation, takeover: !!params.existing };
      } catch (error) {
        if (!conditional(error)) throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
        if (transactionReason(error, 0) === "ConditionalCheckFailed" || !(await this.isStillDeepEntitled(params.userId))) throw new ServerFoundationError("READING_DEEP_NOT_ENTITLED");
        const concurrent = await this.readIdempotency(reservation.requestRef);
        if (concurrent) {
          const classified = await this.classifyExisting({ existing: concurrent, requestRef: reservation.requestRef, fingerprint: reservation.fingerprint, userId: params.userId, now: params.now });
          if (classified !== "reclaim") return classified;
        }
      }
    }
    throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE");
  }

  private retryUpdate(existing: Item, reservation: Reservation, now: Date) {
    const epoch = Math.floor(now.getTime() / 1000);
    const concurrencySet = reservation.rateControl?.concurrencyRef
      ? ", concurrency_schema_version=:concurrencySchema, concurrency_ref=:concurrencyRef, concurrency_reservation_id=:concurrencyReservation, concurrency_expires_at=:concurrencyExpiry"
      : "";
    return {
      TableName: this.config.idempotencyTable,
      Key: { request_ref: S(reservation.requestRef) },
      UpdateExpression: `SET #state=:progress, owner_token=:owner, updated_at=:updated, lease_expires_at=:lease, expires_at=:ttl, deep_quota_schema_version=:schema, deep_period_key=:period, deep_reservation_id=:reservation, deep_reservation_state=:reserved, deep_reservation_expires_at=:reservationExpiry${concurrencySet} REMOVE failure_category, failed_at`,
      ConditionExpression: "fingerprint=:fingerprint AND (#state=:failed OR lease_expires_at<=:now OR expires_at<=:now)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":progress": S("IN_PROGRESS"), ":failed": S("FAILED"), ":owner": S(reservation.ownerToken),
        ":updated": S(now.toISOString()), ":lease": N(epoch + this.config.leaseSeconds), ":ttl": N(epoch + this.config.ttlSeconds),
        ":now": N(epoch), ":fingerprint": S(reservation.fingerprint), ":schema": S(DEEP_QUOTA_SCHEMA_VERSION),
        ":period": S(reservation.deep!.periodKey), ":reservation": S(reservation.deep!.reservationId),
        ":reserved": S("RESERVED"), ":reservationExpiry": N(reservation.deep!.reservationExpiresAt),
        ...(reservation.rateControl?.concurrencyRef ? {
          ":concurrencySchema": S("shirone-reading-concurrency-v1"),
          ":concurrencyRef": S(reservation.rateControl.concurrencyRef),
          ":concurrencyReservation": S(reservation.rateControl.concurrencyReservationId!),
          ":concurrencyExpiry": N(reservation.rateControl.concurrencyExpiresAt!),
        } : {}),
      },
    };
  }

  private takeoverUpdate(existing: Item, reservation: Reservation, now: Date) {
    if (reservation.deep) return this.retryUpdate(existing, reservation, now);
    const epoch = Math.floor(now.getTime() / 1000);
    const concurrencySet = reservation.rateControl?.concurrencyRef
      ? ", concurrency_schema_version=:concurrencySchema, concurrency_ref=:concurrencyRef, concurrency_reservation_id=:concurrencyReservation, concurrency_expires_at=:concurrencyExpiry"
      : "";
    return {
      TableName: this.config.idempotencyTable,
      Key: { request_ref: S(reservation.requestRef) },
      UpdateExpression: `SET #state=:progress, owner_token=:owner, updated_at=:updated, lease_expires_at=:lease, expires_at=:ttl${concurrencySet} REMOVE failure_category`,
      ConditionExpression: "fingerprint=:fingerprint AND (#state=:failed OR lease_expires_at<=:now OR expires_at<=:now)",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":progress": S("IN_PROGRESS"), ":failed": S("FAILED"), ":owner": S(reservation.ownerToken),
        ":updated": S(now.toISOString()), ":lease": N(epoch + this.config.leaseSeconds), ":ttl": N(epoch + this.config.ttlSeconds),
        ":now": N(epoch), ":fingerprint": S(reservation.fingerprint),
        ...(reservation.rateControl?.concurrencyRef ? {
          ":concurrencySchema": S("shirone-reading-concurrency-v1"),
          ":concurrencyRef": S(reservation.rateControl.concurrencyRef),
          ":concurrencyReservation": S(reservation.rateControl.concurrencyReservationId!),
          ":concurrencyExpiry": N(reservation.rateControl.concurrencyExpiresAt!),
        } : {}),
      },
    };
  }

  async begin(params: { requestRef: string; fingerprint: string; userId: string; membershipTier: MembershipTier; resolvedMode: Reservation["resolvedMode"]; readingDate: string; now: Date }): Promise<BeginResult> {
    const reservation = this.reservation(params);
    if (params.resolvedMode === "deep") {
      const existing = await this.readIdempotency(params.requestRef);
      if (existing) {
        const classified = await this.classifyExisting({ existing, ...params });
        if (classified !== "reclaim") return classified;
      }
      return this.reserveDeep({ reservation: existing ? { ...reservation, historyId: text(existing, "history_id") || reservation.historyId, createdAt: text(existing, "created_at") || reservation.createdAt } : reservation, userId: params.userId, membershipTier: params.membershipTier, now: params.now, existing });
    }

    // Direct repository tests and migration tooling may intentionally omit the
    // optional rate-limit adapter. The HTTP Lambda always supplies the strict
    // configuration, so its fail-closed boundary remains intact.
    if (!this.rateLimiter) {
      try {
        await this.sender.send(new PutItemCommand({
          TableName: this.config.idempotencyTable,
          Item: this.idempotencyItem(reservation, params.now),
          ConditionExpression: "attribute_not_exists(request_ref)",
        }));
        return { kind: "acquired", reservation, takeover: false };
      } catch (error) {
        if (!conditional(error)) throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE", { cause: error });
        const existing = await this.readIdempotency(params.requestRef);
        if (!existing) return { kind: "in_progress" };
        const classified = await this.classifyExisting({ existing, ...params });
        if (classified !== "reclaim") return classified;
        const reclaimed = {
          ...reservation,
          historyId: text(existing, "history_id") || reservation.historyId,
          createdAt: text(existing, "created_at") || reservation.createdAt,
        };
        try {
          await this.sender.send(new UpdateItemCommand(this.takeoverUpdate(existing, reclaimed, params.now)));
          return { kind: "acquired", reservation: reclaimed, takeover: true };
        } catch (takeoverError) {
          if (conditional(takeoverError)) return { kind: "in_progress" };
          throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE", { cause: takeoverError });
        }
      }
    }

    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt += 1) {
      const existing = await this.readIdempotency(params.requestRef);
      if (existing) {
        const classified = await this.classifyExisting({ existing, ...params });
        if (classified !== "reclaim") return classified;
      }
      const acquired = await this.rateLimiter.prepareAcquire({
        userId: params.userId,
        tier: params.membershipTier,
        mode: params.resolvedMode,
        requestRef: params.requestRef,
        ownerToken: reservation.ownerToken,
        now: params.now,
      });
      const next = {
        ...reservation,
        historyId: existing ? text(existing, "history_id") || reservation.historyId : reservation.historyId,
        createdAt: existing ? text(existing, "created_at") || reservation.createdAt : reservation.createdAt,
        rateControl: acquired.reservation,
      };
      const idempotencyAction: TransactWriteItem = existing
        ? { Update: this.takeoverUpdate(existing, next, params.now) }
        : { Put: { TableName: this.config.idempotencyTable, Item: this.idempotencyItem(next, params.now), ConditionExpression: "attribute_not_exists(request_ref)" } };
      try {
        await this.sender.send(new TransactWriteItemsCommand({ TransactItems: [...acquired.actions, idempotencyAction], ClientRequestToken: phaseToken(existing ? "reading-retry" : "reading-begin", next, String(attempt)) }));
        return { kind: "acquired", reservation: next, takeover: !!existing };
      } catch (error) {
        if (!conditional(error)) throw new ServerFoundationError("READING_RATE_LIMIT_UNAVAILABLE", { cause: error });
        const concurrent = await this.readIdempotency(params.requestRef);
        if (concurrent) {
          const classified = await this.classifyExisting({ existing: concurrent, ...params });
          if (classified !== "reclaim") return classified;
        }
      }
    }
    throw new ServerFoundationError("READING_RATE_LIMIT_UNAVAILABLE");
  }

  private stored(params: { reservation: Reservation; response: any }): { stored: StoredReading; history: Item } {
    const stored: StoredReading = {
      history_id: params.reservation.historyId,
      created_at: params.reservation.createdAt,
      resolved_mode: params.response.resolved_mode,
      status: "completed",
      rendering_status: params.response.rendering_status,
      result: params.response.result,
    };
    const json = JSON.stringify({ resolved_mode: stored.resolved_mode, status: stored.status, rendering_status: stored.rendering_status, result: stored.result });
    if (Buffer.byteLength(json, "utf8") > 300_000) throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE");
    return { stored, history: {
      user_id: S(""),
      history_id: S(stored.history_id),
      schema_version: S("shirone-reading-history-v1"),
      status: S("completed"),
      resolved_mode: S(stored.resolved_mode),
      reading_date: S(params.reservation.readingDate),
      created_at: S(stored.created_at),
      updated_at: S(""),
      source: S("server_reading_api_v1"),
      public_result: S(json),
    } };
  }

  async complete(params: { reservation: Reservation; userId: string; response: any; now: Date }): Promise<StoredReading> {
    const { stored, history } = this.stored(params);
    history.user_id = S(params.userId);
    history.updated_at = S(params.now.toISOString());
    const release = params.reservation.deep ? undefined : await this.concurrencyRelease(params.reservation, params.now);
    const baseActions = (): TransactWriteItem[] => [
      { Put: { TableName: this.config.historyTable, Item: history, ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(history_id)" } },
      { Update: {
        TableName: this.config.idempotencyTable,
        Key: { request_ref: S(params.reservation.requestRef) },
        UpdateExpression: `SET #state=:completed, completed_at=:now, updated_at=:now${params.reservation.deep ? ", deep_reservation_state=:consumed" : ""} REMOVE owner_token`,
        ConditionExpression: `#state=:progress AND fingerprint=:fingerprint AND owner_token=:owner AND history_id=:history${params.reservation.deep ? " AND resolved_mode=:deep AND deep_reservation_state=:reserved AND deep_reservation_id=:reservation AND deep_period_key=:period" : ""}`,
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":completed": S("COMPLETED"), ":progress": S("IN_PROGRESS"), ":now": S(params.now.toISOString()),
          ":fingerprint": S(params.reservation.fingerprint), ":owner": S(params.reservation.ownerToken), ":history": S(params.reservation.historyId),
          ...(params.reservation.deep ? { ":deep": S("deep"), ":reserved": S("RESERVED"), ":consumed": S("CONSUMED"), ":reservation": S(params.reservation.deep.reservationId), ":period": S(params.reservation.deep.periodKey) } : {}),
        },
      } },
      ...(release ? [release] : []),
    ];

    if (!params.reservation.deep) {
      try {
        await this.sender.send(new TransactWriteItemsCommand({ TransactItems: baseActions(), ClientRequestToken: phaseToken("reading-complete", params.reservation) }));
        return stored;
      } catch (error) {
        if (error instanceof ServerFoundationError) throw error;
        throw new ServerFoundationError("PERSISTENCE_UNAVAILABLE", { cause: error });
      }
    }

    const deepConfig = this.config.deepQuota;
    if (!deepConfig) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt += 1) {
      const previous = await this.readQuota(params.reservation.deep.quotaRef, params.reservation.deep.periodKey);
      if (!previous) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
      const match = previous.reservations.find((value) => value.reservationId === params.reservation.deep!.reservationId && value.requestRef === params.reservation.requestRef && value.historyId === params.reservation.historyId);
      if (!match || previous.used >= PREMIUM_DEEP_MONTHLY_LIMIT) {
        const existing = await this.readIdempotency(params.reservation.requestRef);
        if (existing && text(existing, "state") === "COMPLETED" && text(existing, "deep_reservation_state") === "CONSUMED") return this.readHistory(params.userId, params.reservation.historyId);
        throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
      }
      const next = { ...previous, used: previous.used + 1, reservations: previous.reservations.filter((value) => value !== match), version: previous.version + 1 };
      const deepRelease = await this.concurrencyRelease(params.reservation, params.now);
      try {
        await this.sender.send(new TransactWriteItemsCommand({
          TransactItems: [...baseActions(), quotaPut(deepConfig.tableName, previous, next, params.now), ...(deepRelease ? [deepRelease] : [])],
          ClientRequestToken: phaseToken("reading-complete", params.reservation, String(previous.version)),
        }));
        return stored;
      } catch (error) {
        const existing = await this.readIdempotency(params.reservation.requestRef);
        if (existing && text(existing, "state") === "COMPLETED" && text(existing, "deep_reservation_state") === "CONSUMED") return this.readHistory(params.userId, params.reservation.historyId);
        if (!conditional(error)) throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
      }
    }
    throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE");
  }

  async fail(params: { reservation: Reservation; now: Date; category: string }): Promise<void> {
    const release = params.reservation.deep ? undefined : await this.concurrencyRelease(params.reservation, params.now);
    if (!params.reservation.deep) {
      const failureUpdate = {
        TableName: this.config.idempotencyTable,
        Key: { request_ref: S(params.reservation.requestRef) },
        UpdateExpression: "SET #state=:failed, failure_category=:category, updated_at=:now REMOVE owner_token",
        ConditionExpression: "#state=:progress AND owner_token=:owner",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":failed": S("FAILED"), ":progress": S("IN_PROGRESS"), ":category": S(params.category.slice(0, 32)), ":now": S(params.now.toISOString()), ":owner": S(params.reservation.ownerToken) },
      };
      try {
        if (release) {
          await this.sender.send(new TransactWriteItemsCommand({
            TransactItems: [{ Update: failureUpdate }, release],
            ClientRequestToken: phaseToken("reading-fail", params.reservation),
          }));
        } else {
          await this.sender.send(new UpdateItemCommand(failureUpdate));
        }
      } catch (error) {
        if (release) throw new ServerFoundationError("READING_RATE_LIMIT_UNAVAILABLE", { cause: error });
        // Legacy callers without rate control retain lease-expiry recovery.
      }
      return;
    }

    const deepConfig = this.config.deepQuota;
    if (!deepConfig) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt += 1) {
      const previous = await this.readQuota(params.reservation.deep.quotaRef, params.reservation.deep.periodKey);
      if (!previous) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
      const match = previous.reservations.find((value) => value.reservationId === params.reservation.deep!.reservationId && value.requestRef === params.reservation.requestRef && value.historyId === params.reservation.historyId);
      if (!match) {
        const existing = await this.readIdempotency(params.reservation.requestRef);
        if (existing && text(existing, "state") === "FAILED" && text(existing, "deep_reservation_state") === "RELEASED") return;
        throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
      }
      const next = { ...previous, reservations: previous.reservations.filter((value) => value !== match), version: previous.version + 1 };
      const deepRelease = await this.concurrencyRelease(params.reservation, params.now);
      try {
        await this.sender.send(new TransactWriteItemsCommand({ TransactItems: [
          { Update: {
            TableName: this.config.idempotencyTable,
            Key: { request_ref: S(params.reservation.requestRef) },
            UpdateExpression: "SET #state=:failed, deep_reservation_state=:released, failure_category=:category, failed_at=:now, updated_at=:now REMOVE owner_token",
            ConditionExpression: "#state=:progress AND fingerprint=:fingerprint AND owner_token=:owner AND history_id=:history AND deep_reservation_state=:reserved AND deep_reservation_id=:reservation",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":failed": S("FAILED"), ":progress": S("IN_PROGRESS"), ":released": S("RELEASED"), ":reserved": S("RESERVED"),
              ":category": S(params.category.slice(0, 32)), ":now": S(params.now.toISOString()), ":fingerprint": S(params.reservation.fingerprint),
              ":owner": S(params.reservation.ownerToken), ":history": S(params.reservation.historyId), ":reservation": S(params.reservation.deep.reservationId),
            },
          } },
          quotaPut(deepConfig.tableName, previous, next, params.now),
          ...(deepRelease ? [deepRelease] : []),
        ], ClientRequestToken: phaseToken("deep-release", params.reservation, String(previous.version)) }));
        return;
      } catch (error) {
        const existing = await this.readIdempotency(params.reservation.requestRef);
        const current = await this.readQuota(params.reservation.deep.quotaRef, params.reservation.deep.periodKey);
        const stillReserved = current?.reservations.some((value) => value.reservationId === params.reservation.deep!.reservationId) ?? false;
        if (existing && text(existing, "state") === "FAILED" && text(existing, "deep_reservation_state") === "RELEASED" && !stillReserved) return;
        if (!conditional(error)) throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE", { cause: error });
      }
    }
    throw new ServerFoundationError("READING_DEEP_QUOTA_UNAVAILABLE");
  }
}

export function createDynamoReadingPersistence(config: ReadingPersistenceConfig): ReadingPersistence {
  return new DynamoReadingPersistence(new DynamoDBClient({ maxAttempts: 1 }), config);
}
