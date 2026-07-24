import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { ServerFoundationError } from "../http/errors";
import type { PublicReadingResponse } from "../readingApi/readingApiTypes";
import { calculateDeepRemaining, createDeepQuotaRef, DEEP_QUOTA_SCHEMA_VERSION, getJstPeriodKey, PREMIUM_DEEP_MONTHLY_LIMIT } from "../readingPersistence/deepQuota";
import type { ReadingPersistenceConfig } from "../readingPersistence/persistenceConfig";
import { fingerprintsEqual } from "../readingPersistence/requestFingerprint";
import { DynamoReadingRateLimiter, type RateControlReservation } from "../readingRateLimit/dynamoReadingRateLimiter";
import type { ReadingAsyncConfig } from "./readingAsyncConfig";
import { READING_JOB_SCHEMA_VERSION, type AsyncAcceptanceInput, type AsyncPrecheckResult, type AsyncReadingPersistence, type ReadingJob, type ReadingJobFailureCategory } from "./readingJobTypes";

type Sender = { send(command: GetItemCommand | UpdateItemCommand | TransactWriteItemsCommand): Promise<any> };
type Item = Record<string, AttributeValue>;
type QuotaReservation = { reservationId: string; requestRef: string; historyId: string; reservedAt: string; expiresAt: number };
type Quota = { quotaRef: string; periodKey: string; used: number; reservations: QuotaReservation[]; version: number; createdAt: string };
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const B = (value: boolean): AttributeValue => ({ BOOL: value });
const text = (item: Item, key: string) => item[key] && "S" in item[key] ? item[key].S ?? "" : "";
const number = (item: Item, key: string) => item[key] && "N" in item[key] ? Number(item[key].N) : Number.NaN;
const conditional = (error: unknown) => !!error && typeof error === "object" && ["ConditionalCheckFailedException", "TransactionCanceledException"].includes((error as { name?: string }).name ?? "");

function canonicalMap(input: ReadingJob["canonicalInput"]): AttributeValue {
  return { M: {
    name: S(input.name), birth_date: S(input.birthDate), reading_date: S(input.readingDate), resolved_mode: S(input.resolvedMode),
    ...(input.question ? { question: S(input.question) } : {}),
  } };
}

function parseCanonical(value: AttributeValue | undefined): ReadingJob["canonicalInput"] {
  if (!value || !("M" in value) || !value.M) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  const mode = text(value.M, "resolved_mode");
  const input = { name: text(value.M, "name"), birthDate: text(value.M, "birth_date"), readingDate: text(value.M, "reading_date"), resolvedMode: mode, ...(text(value.M, "question") ? { question: text(value.M, "question") } : {}) };
  if (!input.name || !/^\d{4}-\d{2}-\d{2}$/u.test(input.birthDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(input.readingDate) || (mode !== "light" && mode !== "deep")) {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  return input as ReadingJob["canonicalInput"];
}

function parsePublic(value: string): Omit<PublicReadingResponse, "request_id"> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ServerFoundationError("READING_JOB_INCONSISTENT"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  const record = parsed as Record<string, unknown>;
  if (record.status !== "completed" || (record.resolved_mode !== "light" && record.resolved_mode !== "deep") || !record.result || typeof record.result !== "object") {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  return record as Omit<PublicReadingResponse, "request_id">;
}

function parseJob(item: Item | undefined): ReadingJob | undefined {
  if (!item) return undefined;
  const mode = text(item, "mode");
  const state = text(item, "state");
  const version = number(item, "version");
  const attemptCount = number(item, "attempt_count");
  if (text(item, "schema_version") !== READING_JOB_SCHEMA_VERSION || (mode !== "light" && mode !== "deep") ||
      !["QUEUED", "IN_PROGRESS", "COMPLETED", "FAILED"].includes(state) || !Number.isSafeInteger(version) || version < 1 ||
      !Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  const job: ReadingJob = {
    jobRef: text(item, "job_ref"), historyId: text(item, "history_id"), requestRef: text(item, "request_ref"),
    fingerprint: text(item, "fingerprint"), mode, state: state as ReadingJob["state"], version,
    ownerUserId: text(item, "owner_user_id"), ownerRef: text(item, "owner_ref"), canonicalInput: parseCanonical(item.canonical_input),
    createdAt: text(item, "created_at"), updatedAt: text(item, "updated_at"), expiresAt: number(item, "expires_at"), attemptCount,
  };
  const optionalText = (key: string) => text(item, key) || undefined;
  const optionalNumber = (key: string) => Number.isSafeInteger(number(item, key)) ? number(item, key) : undefined;
  job.leaseOwner = optionalText("lease_owner"); job.leaseExpiresAt = optionalNumber("lease_expires_at");
  job.concurrencyRef = optionalText("concurrency_ref"); job.concurrencyReservationId = optionalText("concurrency_reservation_id"); job.concurrencyExpiresAt = optionalNumber("concurrency_expires_at");
  const staged = optionalText("staged_public_result"); if (staged) job.stagedResult = parsePublic(staged);
  const failure = optionalText("safe_failure_category"); if (failure) job.safeFailureCategory = failure as ReadingJobFailureCategory;
  const deepId = optionalText("deep_reservation_id");
  if (deepId) job.deepReservation = { quotaRef: optionalText("deep_quota_ref")!, periodKey: optionalText("deep_period_key")!, reservationId: deepId, reservationExpiresAt: optionalNumber("deep_reservation_expires_at")! };
  if (!job.jobRef || !job.historyId || !/^[0-9a-f]{64}$/u.test(job.requestRef) || !/^[0-9a-f]{64}$/u.test(job.fingerprint) || !job.ownerUserId || !/^[0-9a-f]{64}$/u.test(job.ownerRef)) {
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }
  return job;
}

function quotaItem(tableName: string, previous: Quota | undefined, next: Quota, now: Date): TransactWriteItem {
  return { Put: { TableName: tableName, Item: {
    quota_ref: S(next.quotaRef), schema_version: S(DEEP_QUOTA_SCHEMA_VERSION), period_key: S(next.periodKey), limit: N(PREMIUM_DEEP_MONTHLY_LIMIT),
    used: N(next.used), reservations: { L: next.reservations.map((value) => ({ M: { reservation_id: S(value.reservationId), request_ref: S(value.requestRef), history_id: S(value.historyId), reserved_at: S(value.reservedAt), expires_at: N(value.expiresAt) } })) },
    version: N(next.version), created_at: S(next.createdAt), updated_at: S(now.toISOString()), expires_at: N(Math.floor(now.getTime() / 1000) + 370 * 24 * 60 * 60),
  }, ConditionExpression: previous ? "#version=:version" : "attribute_not_exists(quota_ref)", ...(previous ? { ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": N(previous.version) } } : {}) } };
}

export class DynamoAsyncReadingPersistence implements AsyncReadingPersistence {
  private rateLimiter: DynamoReadingRateLimiter;
  constructor(private sender: Sender, private config: ReadingPersistenceConfig & ReadingAsyncConfig, private uuid = randomUUID) {
    if (!config.rateLimit) throw new ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED");
    this.rateLimiter = new DynamoReadingRateLimiter(sender as any, config.rateLimit);
  }

  private async get(table: string, key: Item): Promise<Item | undefined> {
    try { return (await this.sender.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item; }
    catch (error) { throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error }); }
  }

  async precheck(params: { requestRef: string; fingerprint: string; userId: string }): Promise<AsyncPrecheckResult> {
    const item = await this.get(this.config.idempotencyTable, { request_ref: S(params.requestRef) });
    if (!item) return { kind: "missing" };
    if (!fingerprintsEqual(text(item, "fingerprint"), params.fingerprint)) return { kind: "conflict" };
    const state = text(item, "state");
    const historyId = text(item, "history_id");
    if (state === "QUEUED") return { kind: "queued", historyId };
    if (state === "IN_PROGRESS") return { kind: "in_progress", historyId };
    if (state === "FAILED") return { kind: "failed" };
    if (state === "COMPLETED") {
      const history = await this.get(this.config.historyTable, { user_id: S(params.userId), history_id: S(historyId) });
      return { kind: "completed", history: parsePublic(text(history ?? {}, "public_result")) };
    }
    throw new ServerFoundationError("READING_JOB_INCONSISTENT");
  }

  private async readQuota(userId: string, now: Date, expected?: { quotaRef: string; periodKey: string }): Promise<Quota | undefined> {
    const deep = this.config.deepQuota;
    if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
    const periodKey = expected?.periodKey ?? getJstPeriodKey(now);
    const quotaRef = expected?.quotaRef ?? createDeepQuotaRef({ userId, periodKey, secret: deep.hashSecret });
    if (createDeepQuotaRef({ userId, periodKey, secret: deep.hashSecret }) !== quotaRef) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
    const item = await this.get(deep.tableName, { quota_ref: S(quotaRef) });
    if (!item) return undefined;
    if (text(item, "schema_version") !== DEEP_QUOTA_SCHEMA_VERSION || text(item, "period_key") !== periodKey || number(item, "limit") !== PREMIUM_DEEP_MONTHLY_LIMIT || !Number.isSafeInteger(number(item, "used")) || !Number.isSafeInteger(number(item, "version"))) {
      throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
    }
    const list = item.reservations && "L" in item.reservations ? item.reservations.L ?? [] : [];
    const reservations = list.map((entry) => {
      if (!("M" in entry) || !entry.M) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
      return { reservationId: text(entry.M, "reservation_id"), requestRef: text(entry.M, "request_ref"), historyId: text(entry.M, "history_id"), reservedAt: text(entry.M, "reserved_at"), expiresAt: number(entry.M, "expires_at") };
    });
    return { quotaRef, periodKey, used: number(item, "used"), reservations, version: number(item, "version"), createdAt: text(item, "created_at") };
  }

  async accept(params: AsyncAcceptanceInput & { jobRef: string; historyId: string }): Promise<"accepted" | "conflict"> {
    const rate = await this.rateLimiter.prepareRateAcquire({ userId: params.userId, tier: params.membershipTier, mode: params.mode, now: params.now });
    const nowEpoch = Math.floor(params.now.getTime() / 1000);
    const actions: TransactWriteItem[] = [...rate.actions];
    let deepReservation: ReadingJob["deepReservation"];
    if (params.mode === "deep") {
      const deep = this.config.deepQuota;
      if (!deep) throw new ServerFoundationError("READING_DEEP_QUOTA_CONFIG_ERROR");
      const previous = await this.readQuota(params.userId, params.now);
      const active = previous?.reservations.filter((entry) => entry.expiresAt > nowEpoch) ?? [];
      if (calculateDeepRemaining({ used: previous?.used ?? 0, activeReservations: active.length }) <= 0) throw new ServerFoundationError("READING_DEEP_MONTHLY_LIMIT_REACHED");
      deepReservation = { quotaRef: previous?.quotaRef ?? createDeepQuotaRef({ userId: params.userId, periodKey: getJstPeriodKey(params.now), secret: deep.hashSecret }), periodKey: previous?.periodKey ?? getJstPeriodKey(params.now), reservationId: this.uuid(), reservationExpiresAt: nowEpoch + deep.reservationSeconds };
      const next: Quota = { quotaRef: deepReservation.quotaRef, periodKey: deepReservation.periodKey, used: previous?.used ?? 0, reservations: [...active, { reservationId: deepReservation.reservationId, requestRef: params.requestRef, historyId: params.historyId, reservedAt: params.now.toISOString(), expiresAt: deepReservation.reservationExpiresAt }], version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? params.now.toISOString() };
      actions.push({ ConditionCheck: { TableName: deep.usersTableName, Key: { user_id: S(params.userId) }, ConditionExpression: "#plan=:premium AND subscription_status=:active AND deep_enabled=:enabled", ExpressionAttributeNames: { "#plan": "plan" }, ExpressionAttributeValues: { ":premium": S("premium"), ":active": S("active"), ":enabled": B(true) } } });
      actions.push(quotaItem(deep.tableName, previous, next, params.now));
    }
    const job: Item = {
      job_ref: S(params.jobRef), schema_version: S(READING_JOB_SCHEMA_VERSION), history_id: S(params.historyId), request_ref: S(params.requestRef), fingerprint: S(params.fingerprint), mode: S(params.mode), state: S("QUEUED"), version: N(1), owner_user_id: S(params.userId), owner_ref: S(params.ownerRef), canonical_input: canonicalMap(params.canonicalInput), created_at: S(params.now.toISOString()), updated_at: S(params.now.toISOString()), attempt_count: N(0), expires_at: N(nowEpoch + this.config.jobTtlSeconds),
      ...(deepReservation ? { deep_quota_ref: S(deepReservation.quotaRef), deep_period_key: S(deepReservation.periodKey), deep_reservation_id: S(deepReservation.reservationId), deep_reservation_expires_at: N(deepReservation.reservationExpiresAt) } : {}),
    };
    actions.push(
      { Put: { TableName: this.config.jobsTable, Item: job, ConditionExpression: "attribute_not_exists(job_ref)" } },
      { Put: { TableName: this.config.historyTable, Item: { user_id: S(params.userId), history_id: S(params.historyId), schema_version: S("shirone-reading-history-v1"), status: S("processing"), resolved_mode: S(params.mode), reading_date: S(params.canonicalInput.readingDate), created_at: S(params.now.toISOString()), updated_at: S(params.now.toISOString()), source: S("server_reading_async_v1") }, ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(history_id)" } },
      { Put: { TableName: this.config.idempotencyTable, Item: { request_ref: S(params.requestRef), schema_version: S("shirone-reading-idempotency-v1"), state: S("QUEUED"), fingerprint: S(params.fingerprint), history_id: S(params.historyId), job_ref: S(params.jobRef), resolved_mode: S(params.mode), created_at: S(params.now.toISOString()), updated_at: S(params.now.toISOString()), expires_at: N(nowEpoch + this.config.ttlSeconds), ...(deepReservation ? { deep_reservation_state: S("RESERVED"), deep_reservation_id: S(deepReservation.reservationId), deep_period_key: S(deepReservation.periodKey) } : {}) }, ConditionExpression: "attribute_not_exists(request_ref)" } },
    );
    try { await this.sender.send(new TransactWriteItemsCommand({ TransactItems: actions })); return "accepted"; }
    catch (error) { if (conditional(error)) return "conflict"; throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error }); }
  }

  async readJob(jobRef: string): Promise<ReadingJob | undefined> {
    return parseJob(await this.get(this.config.jobsTable, { job_ref: S(jobRef) }));
  }

  async claim(params: { job: ReadingJob; workerMode: "light" | "deep"; leaseOwner: string; now: Date }) {
    if (params.job.mode !== params.workerMode) return { kind: "mode_mismatch" as const };
    if (params.job.state === "COMPLETED" || params.job.state === "FAILED") return { kind: "terminal" as const };
    const nowEpoch = Math.floor(params.now.getTime() / 1000);
    if (params.job.state === "IN_PROGRESS" && (params.job.leaseExpiresAt ?? 0) > nowEpoch) return { kind: "active" as const };
    const concurrency = await this.rateLimiter.prepareConcurrencyAcquire({ userId: params.job.ownerUserId, mode: params.job.mode, requestRef: params.job.requestRef, ownerToken: params.leaseOwner, now: params.now });
    const leaseSeconds = params.job.mode === "light" ? this.config.lightLeaseSeconds : this.config.deepLeaseSeconds;
    const leaseExpiresAt = nowEpoch + leaseSeconds;
    const action: TransactWriteItem = { Update: { TableName: this.config.jobsTable, Key: { job_ref: S(params.job.jobRef) }, UpdateExpression: "SET #state=:progress, lease_owner=:owner, lease_expires_at=:lease, concurrency_ref=:concurrency, concurrency_reservation_id=:reservation, concurrency_expires_at=:concurrencyExpiry, attempt_count=:attempt, #version=:nextVersion, updated_at=:now", ConditionExpression: "#version=:version AND (#state=:queued OR (#state=:progress AND lease_expires_at<=:epoch))", ExpressionAttributeNames: { "#state": "state", "#version": "version" }, ExpressionAttributeValues: { ":progress": S("IN_PROGRESS"), ":queued": S("QUEUED"), ":owner": S(params.leaseOwner), ":lease": N(leaseExpiresAt), ":concurrency": S(concurrency.reservation.concurrencyRef!), ":reservation": S(concurrency.reservation.concurrencyReservationId!), ":concurrencyExpiry": N(concurrency.reservation.concurrencyExpiresAt!), ":attempt": N(params.job.attemptCount + 1), ":nextVersion": N(params.job.version + 1), ":version": N(params.job.version), ":now": S(params.now.toISOString()), ":epoch": N(nowEpoch) } } };
    try {
      await this.sender.send(new TransactWriteItemsCommand({ TransactItems: [...concurrency.actions, action] }));
      return { kind: "claimed" as const, job: { ...params.job, state: "IN_PROGRESS" as const, version: params.job.version + 1, leaseOwner: params.leaseOwner, leaseExpiresAt, concurrencyRef: concurrency.reservation.concurrencyRef, concurrencyReservationId: concurrency.reservation.concurrencyReservationId, concurrencyExpiresAt: concurrency.reservation.concurrencyExpiresAt, attemptCount: params.job.attemptCount + 1, updatedAt: params.now.toISOString() } };
    } catch (error) {
      if (error instanceof ServerFoundationError && error.code === "READING_CONCURRENT_LIMIT_REACHED") return { kind: "retry" as const, retryAfter: error.retryAfter };
      if (conditional(error)) return { kind: "active" as const };
      throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error });
    }
  }

  async stageResult(params: { job: ReadingJob; result: Omit<PublicReadingResponse, "request_id">; now: Date }): Promise<ReadingJob> {
    const json = JSON.stringify(params.result);
    if (Buffer.byteLength(json, "utf8") > 300_000) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
    try { await this.sender.send(new UpdateItemCommand({ TableName: this.config.jobsTable, Key: { job_ref: S(params.job.jobRef) }, UpdateExpression: "SET staged_public_result=:result, updated_at=:now, #version=:next", ConditionExpression: "#state=:progress AND #version=:version AND lease_owner=:owner", ExpressionAttributeNames: { "#state": "state", "#version": "version" }, ExpressionAttributeValues: { ":result": S(json), ":now": S(params.now.toISOString()), ":next": N(params.job.version + 1), ":progress": S("IN_PROGRESS"), ":version": N(params.job.version), ":owner": S(params.job.leaseOwner!) } })); }
    catch (error) {
      // Ambiguous SDK failures may occur after DynamoDB committed the write.
      // Confirm strong state before deciding whether a provider rerun is safe.
      const latest = await this.readJob(params.job.jobRef);
      if (latest?.stagedResult && latest.leaseOwner === params.job.leaseOwner) return latest;
      throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error });
    }
    return { ...params.job, stagedResult: params.result, version: params.job.version + 1, updatedAt: params.now.toISOString() };
  }

  private concurrencyReservation(job: ReadingJob): RateControlReservation {
    return { rateRef: "", rateWindowEnd: 0, concurrencyRef: job.concurrencyRef, concurrencyReservationId: job.concurrencyReservationId, concurrencyExpiresAt: job.concurrencyExpiresAt };
  }

  async complete(params: { job: ReadingJob; now: Date }): Promise<void> {
    if (!params.job.stagedResult || !params.job.leaseOwner) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
    const release = await this.rateLimiter.prepareConcurrencyRelease(this.concurrencyReservation(params.job), params.job.requestRef, params.now);
    const publicJson = JSON.stringify(params.job.stagedResult);
    const actions: TransactWriteItem[] = [
      { Update: { TableName: this.config.jobsTable, Key: { job_ref: S(params.job.jobRef) }, UpdateExpression: "SET #state=:completed, #version=:next, updated_at=:now REMOVE lease_owner, lease_expires_at", ConditionExpression: "#state=:progress AND #version=:version AND lease_owner=:owner", ExpressionAttributeNames: { "#state": "state", "#version": "version" }, ExpressionAttributeValues: { ":completed": S("COMPLETED"), ":progress": S("IN_PROGRESS"), ":next": N(params.job.version + 1), ":version": N(params.job.version), ":owner": S(params.job.leaseOwner), ":now": S(params.now.toISOString()) } } },
      { Update: { TableName: this.config.historyTable, Key: { user_id: S(params.job.ownerUserId), history_id: S(params.job.historyId) }, UpdateExpression: "SET #status=:completed, public_result=:result, updated_at=:now", ConditionExpression: "#status=:processing", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":completed": S("completed"), ":processing": S("processing"), ":result": S(publicJson), ":now": S(params.now.toISOString()) } } },
      { Update: { TableName: this.config.idempotencyTable, Key: { request_ref: S(params.job.requestRef) }, UpdateExpression: "SET #state=:completed, updated_at=:now", ConditionExpression: "(#state=:queued OR #state=:progress) AND fingerprint=:fingerprint AND history_id=:history", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":completed": S("COMPLETED"), ":queued": S("QUEUED"), ":progress": S("IN_PROGRESS"), ":fingerprint": S(params.job.fingerprint), ":history": S(params.job.historyId), ":now": S(params.now.toISOString()) } } },
      ...(release ? [release] : []),
    ];
    if (params.job.deepReservation) await this.addDeepTerminalActions(actions, params.job, params.now, true);
    try { await this.sender.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) { throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error }); }
  }

  private async addDeepTerminalActions(actions: TransactWriteItem[], job: ReadingJob, now: Date, consume: boolean) {
    const deep = this.config.deepQuota; const reservation = job.deepReservation;
    if (!deep || !reservation) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
    const previous = await this.readQuota(job.ownerUserId, now, { quotaRef: reservation.quotaRef, periodKey: reservation.periodKey });
    if (!previous) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
    const match = previous.reservations.find((entry) => entry.reservationId === reservation.reservationId && entry.requestRef === job.requestRef);
    if (!match || (consume && previous.used >= PREMIUM_DEEP_MONTHLY_LIMIT)) throw new ServerFoundationError("READING_DEEP_RESERVATION_INCONSISTENT");
    const next = { ...previous, used: previous.used + (consume ? 1 : 0), reservations: previous.reservations.filter((entry) => entry !== match), version: previous.version + 1 };
    actions.push(quotaItem(deep.tableName, previous, next, now));
  }

  async fail(params: { job: ReadingJob; category: ReadingJobFailureCategory; now: Date }): Promise<void> {
    const release = await this.rateLimiter.prepareConcurrencyRelease(this.concurrencyReservation(params.job), params.job.requestRef, params.now);
    const actions: TransactWriteItem[] = [
      { Update: { TableName: this.config.jobsTable, Key: { job_ref: S(params.job.jobRef) }, UpdateExpression: "SET #state=:failed, safe_failure_category=:category, #version=:next, updated_at=:now REMOVE lease_owner, lease_expires_at, staged_public_result", ConditionExpression: "#state=:progress AND #version=:version AND lease_owner=:owner", ExpressionAttributeNames: { "#state": "state", "#version": "version" }, ExpressionAttributeValues: { ":failed": S("FAILED"), ":progress": S("IN_PROGRESS"), ":category": S(params.category), ":next": N(params.job.version + 1), ":version": N(params.job.version), ":owner": S(params.job.leaseOwner!), ":now": S(params.now.toISOString()) } } },
      { Update: { TableName: this.config.historyTable, Key: { user_id: S(params.job.ownerUserId), history_id: S(params.job.historyId) }, UpdateExpression: "SET #status=:error, error_code=:code, updated_at=:now", ConditionExpression: "#status=:processing", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":error": S("error"), ":processing": S("processing"), ":code": S("READING_GENERATION_FAILED"), ":now": S(params.now.toISOString()) } } },
      { Update: { TableName: this.config.idempotencyTable, Key: { request_ref: S(params.job.requestRef) }, UpdateExpression: "SET #state=:failed, failure_category=:category, updated_at=:now", ConditionExpression: "(#state=:queued OR #state=:progress) AND fingerprint=:fingerprint", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":failed": S("FAILED"), ":queued": S("QUEUED"), ":progress": S("IN_PROGRESS"), ":category": S(params.category), ":fingerprint": S(params.job.fingerprint), ":now": S(params.now.toISOString()) } } },
      ...(release ? [release] : []),
    ];
    if (params.job.deepReservation) await this.addDeepTerminalActions(actions, params.job, params.now, false);
    try { await this.sender.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) { throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error }); }
  }

  async requeue(params: { job: ReadingJob; now: Date }): Promise<void> {
    const release = await this.rateLimiter.prepareConcurrencyRelease(this.concurrencyReservation(params.job), params.job.requestRef, params.now);
    const actions: TransactWriteItem[] = [{ Update: { TableName: this.config.jobsTable, Key: { job_ref: S(params.job.jobRef) }, UpdateExpression: "SET #state=:queued, #version=:next, updated_at=:now REMOVE lease_owner, lease_expires_at, staged_public_result", ConditionExpression: "#state=:progress AND #version=:version AND lease_owner=:owner", ExpressionAttributeNames: { "#state": "state", "#version": "version" }, ExpressionAttributeValues: { ":queued": S("QUEUED"), ":progress": S("IN_PROGRESS"), ":next": N(params.job.version + 1), ":version": N(params.job.version), ":owner": S(params.job.leaseOwner!), ":now": S(params.now.toISOString()) } } }, ...(release ? [release] : [])];
    try { await this.sender.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) { throw new ServerFoundationError("READING_JOB_UNAVAILABLE", { cause: error }); }
  }
}

export function createDynamoAsyncReadingPersistence(config: ReadingPersistenceConfig & ReadingAsyncConfig): AsyncReadingPersistence {
  return new DynamoAsyncReadingPersistence(new DynamoDBClient({ maxAttempts: 1 }), config);
}
