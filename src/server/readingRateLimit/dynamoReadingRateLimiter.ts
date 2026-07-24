import { GetItemCommand, type AttributeValue, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import { createConcurrencyRef, createRateWindowRef } from "./rateLimitRef";
import { resolveRatePolicy, type MembershipTier, type RateLimitReadingMode, type ReadingRateLimitConfig } from "./rateLimitPolicy";

type Sender = { send(command: GetItemCommand): Promise<any> };
type Item = Record<string, AttributeValue>;
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const text = (item: Item, key: string) => item[key] && "S" in item[key] ? item[key].S ?? "" : "";
const number = (item: Item, key: string) => item[key] && "N" in item[key] ? Number(item[key].N) : Number.NaN;

export type RateControlReservation = {
  rateRef: string;
  rateWindowEnd: number;
  concurrencyRef?: string;
  concurrencyReservationId?: string;
  concurrencyExpiresAt?: number;
  concurrencyExpiredReclaimed?: boolean;
};

type ConcurrencyReservation = { requestRef: string; reservationId: string; expiresAt: number; reservedAt: string };

export class DynamoReadingRateLimiter {
  constructor(private sender: Sender, readonly config: ReadingRateLimitConfig) {}

  private async read(ref: string): Promise<Item | undefined> {
    try {
      return (await this.sender.send(new GetItemCommand({
        TableName: this.config.tableName,
        Key: { rate_limit_ref: S(ref) },
        ConsistentRead: true,
      }))).Item;
    } catch (error) {
      throw new ServerFoundationError("READING_RATE_LIMIT_UNAVAILABLE", { cause: error });
    }
  }

  async prepareRateAcquire(params: {
    userId: string;
    tier: MembershipTier;
    mode: RateLimitReadingMode;
    now: Date;
  }): Promise<{ reservation: RateControlReservation; actions: TransactWriteItem[]; retryAfter: number }> {
    const { scope, policy } = resolveRatePolicy(this.config, params.tier, params.mode);
    const nowEpoch = Math.floor(params.now.getTime() / 1000);
    const windowStart = Math.floor(nowEpoch / policy.windowSeconds) * policy.windowSeconds;
    const windowEnd = windowStart + policy.windowSeconds;
    const rateRef = createRateWindowRef({
      userId: params.userId,
      tier: params.tier,
      mode: params.mode,
      windowStart,
      secret: this.config.hashSecret,
    });
    const previous = await this.read(rateRef);
    let used = 0;
    let version = 0;
    let createdAt = params.now.toISOString();
    if (previous) {
      if (text(previous, "schema_version") !== "shirone-reading-rate-window-v1" || text(previous, "scope") !== scope ||
          number(previous, "window_start_epoch") !== windowStart || number(previous, "window_seconds") !== policy.windowSeconds ||
          number(previous, "limit") !== policy.max || !Number.isSafeInteger(number(previous, "used")) || number(previous, "used") < 0 ||
          !Number.isSafeInteger(number(previous, "version")) || number(previous, "version") < 1) {
        throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
      }
      used = number(previous, "used");
      version = number(previous, "version");
      createdAt = text(previous, "created_at");
    }
    if (used >= policy.max) {
      throw new ServerFoundationError("READING_RATE_LIMIT_REACHED", { retryAfter: Math.max(1, windowEnd - nowEpoch) });
    }
    return {
      reservation: { rateRef, rateWindowEnd: windowEnd },
      actions: [{ Put: {
        TableName: this.config.tableName,
        Item: {
          rate_limit_ref: S(rateRef), schema_version: S("shirone-reading-rate-window-v1"), scope: S(scope),
          window_start_epoch: N(windowStart), window_seconds: N(policy.windowSeconds), limit: N(policy.max),
          used: N(used + 1), version: N(version + 1), created_at: S(createdAt), updated_at: S(params.now.toISOString()),
          expires_at: N(windowEnd + policy.windowSeconds),
        },
        ConditionExpression: previous ? "#version=:version" : "attribute_not_exists(rate_limit_ref)",
        ...(previous ? { ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": N(version) } } : {}),
      } }],
      retryAfter: Math.max(1, windowEnd - nowEpoch),
    };
  }

  async prepareConcurrencyAcquire(params: {
    userId: string;
    mode: "light" | "deep";
    requestRef: string;
    ownerToken: string;
    now: Date;
  }): Promise<{ reservation: RateControlReservation; actions: TransactWriteItem[] }> {
    if (!/^[0-9a-f]{64}$/u.test(params.requestRef) || !params.ownerToken || params.ownerToken.length > 128 || /[\u0000-\u001f\u007f]/u.test(params.ownerToken)) {
      throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
    }
    const nowEpoch = Math.floor(params.now.getTime() / 1000);
    const concurrencyRef = createConcurrencyRef({ userId: params.userId, mode: params.mode, secret: this.config.hashSecret });
    const current = await this.read(concurrencyRef);
    let currentVersion = 0;
    let createdAt = params.now.toISOString();
    let active: ConcurrencyReservation[] = [];
    let expiredCount = 0;
    if (current) {
      if (text(current, "schema_version") !== "shirone-reading-concurrency-v1" || text(current, "scope") !== params.mode ||
          number(current, "limit") !== 1 || !Number.isSafeInteger(number(current, "version")) || number(current, "version") < 1) {
        throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
      }
      const list = current.reservations;
      if (!list || !("L" in list) || !list.L || list.L.length > 1) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
      const parsed = list.L.map((entry) => {
        if (!("M" in entry) || !entry.M) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
        return {
          requestRef: text(entry.M, "request_ref"), reservationId: text(entry.M, "reservation_id"),
          reservedAt: text(entry.M, "reserved_at"), expiresAt: number(entry.M, "expires_at"),
        };
      });
      if (parsed.some((entry) => !/^[0-9a-f]{64}$/u.test(entry.requestRef) || !entry.reservationId || !entry.reservedAt || !Number.isSafeInteger(entry.expiresAt))) {
        throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
      }
      active = parsed.filter((entry) => entry.expiresAt > nowEpoch);
      expiredCount = parsed.length - active.length;
      currentVersion = number(current, "version");
      createdAt = text(current, "created_at");
    }
    const reusable = active.find((entry) => entry.requestRef === params.requestRef);
    if (active.length && !reusable) {
      const retry = Math.max(1, Math.min(...active.map((entry) => entry.expiresAt)) - nowEpoch);
      throw new ServerFoundationError("READING_CONCURRENT_LIMIT_REACHED", { retryAfter: retry });
    }
    const next = reusable ?? {
      requestRef: params.requestRef,
      reservationId: params.ownerToken,
      reservedAt: params.now.toISOString(),
      expiresAt: nowEpoch + this.config.concurrency.leaseSeconds,
    };
    const reservation: RateControlReservation = {
      rateRef: "",
      rateWindowEnd: 0,
      concurrencyRef,
      concurrencyReservationId: next.reservationId,
      concurrencyExpiresAt: next.expiresAt,
      ...(!reusable && expiredCount > 0 ? { concurrencyExpiredReclaimed: true } : {}),
    };
    return { reservation, actions: [{ Put: {
      TableName: this.config.tableName,
      Item: {
        rate_limit_ref: S(concurrencyRef), schema_version: S("shirone-reading-concurrency-v1"), scope: S(params.mode), limit: N(1),
        reservations: { L: [{ M: { request_ref: S(next.requestRef), reservation_id: S(next.reservationId), reserved_at: S(next.reservedAt), expires_at: N(next.expiresAt) } }] },
        version: N(currentVersion + 1), created_at: S(createdAt), updated_at: S(params.now.toISOString()),
        expires_at: N(next.expiresAt + this.config.concurrency.leaseSeconds),
      },
      ConditionExpression: current ? "#version=:version" : "attribute_not_exists(rate_limit_ref)",
      ...(current ? { ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": N(currentVersion) } } : {}),
    } }] };
  }

  async prepareAcquire(params: { userId: string; tier: MembershipTier; mode: RateLimitReadingMode; requestRef: string; ownerToken: string; now: Date }) {
    const rate = await this.prepareRateAcquire(params);
    if (params.mode === "free") return rate;
    const concurrency = await this.prepareConcurrencyAcquire({
      userId: params.userId,
      mode: params.mode,
      requestRef: params.requestRef,
      ownerToken: params.ownerToken,
      now: params.now,
    });
    return {
      reservation: { ...rate.reservation, ...concurrency.reservation, rateRef: rate.reservation.rateRef, rateWindowEnd: rate.reservation.rateWindowEnd },
      actions: [...rate.actions, ...concurrency.actions],
      retryAfter: rate.retryAfter,
    };
  }

  async prepareConcurrencyRelease(reservation: RateControlReservation, requestRef: string, now: Date): Promise<TransactWriteItem | undefined> {
    if (!reservation.concurrencyRef || !reservation.concurrencyReservationId) return undefined;
    const current = await this.read(reservation.concurrencyRef);
    if (!current) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
    const list = current.reservations;
    if (!list || !("L" in list) || !list.L) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
    const match = list.L.find((entry) => "M" in entry && entry.M && text(entry.M, "request_ref") === requestRef && text(entry.M, "reservation_id") === reservation.concurrencyReservationId);
    if (!match) throw new ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT");
    return { Put: {
      TableName: this.config.tableName,
      Item: { ...current, reservations: { L: [] }, version: N(number(current, "version") + 1), updated_at: S(now.toISOString()), expires_at: N(Math.floor(now.getTime() / 1000) + this.config.concurrency.leaseSeconds) },
      ConditionExpression: "#version=:version AND reservations[0].reservation_id=:reservation",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": N(number(current, "version")), ":reservation": S(reservation.concurrencyReservationId) },
    } };
  }

  async prepareRelease(reservation: RateControlReservation, requestRef: string, now: Date) {
    return this.prepareConcurrencyRelease(reservation, requestRef, now);
  }
}
