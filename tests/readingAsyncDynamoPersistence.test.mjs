import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?async-dynamo=${Date.now()}`);
const config = { idempotencyTable: "idem", historyTable: "history", hashSecret: "fixture-only-idempotency-secret-32-characters-minimum", leaseSeconds: 120, ttlSeconds: 604800, jobsTable: "jobs", jobTtlSeconds: 604800, lightLeaseSeconds: 180, deepLeaseSeconds: 360, orphanGraceSeconds: 60, rateLimit: { tableName: "rate", hashSecret: "fixture-only-idempotency-secret-32-characters-minimum", policies: { "free/free": { max: 3, windowSeconds: 60 }, "light/free": { max: 3, windowSeconds: 60 }, "light/light": { max: 3, windowSeconds: 60 }, "premium/free": { max: 3, windowSeconds: 60 }, "premium/light": { max: 3, windowSeconds: 60 }, "premium/deep": { max: 3, windowSeconds: 60 } }, concurrency: { light: 1, deep: 1, leaseSeconds: 180 } } };
const deepConfig = { ...config, deepQuota: { tableName: "deep-quota", usersTableName: "users", hashSecret: "fixture-only-deep-quota-secret-32-characters-minimum", reservationSeconds: 600 } };
class Sender {
  constructor() { this.transactions = []; }
  async send(command) {
    if (command.constructor.name === "GetItemCommand") return {};
    if (command.constructor.name === "TransactWriteItemsCommand") { this.transactions.push(command.input.TransactItems); return {}; }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}
const input = { requestRef: "a".repeat(64), fingerprint: "b".repeat(64), userId: "fixture-user-private", ownerRef: "c".repeat(64), membershipTier: "light", mode: "light", canonicalInput: { name: "架空 花子", birthDate: "1984-12-29", readingDate: "2026-07-24", resolvedMode: "light" }, now: new Date("2026-07-24T00:00:00Z"), jobRef: "11111111-1111-4111-8111-111111111111", historyId: "22222222-2222-4222-8222-222222222222" };

test("acceptance transaction includes rate, job, processing history, and idempotency but no concurrency", async () => {
  const sender = new Sender(); const store = new api.DynamoAsyncReadingPersistence(sender, config);
  assert.equal(await store.accept(input), "accepted");
  const actions = sender.transactions[0];
  const serialized = JSON.stringify(actions);
  assert.match(serialized, /shirone-reading-rate-window-v1/);
  assert.match(serialized, /shirone-reading-job-v1/);
  assert.match(serialized, /processing/);
  assert.match(serialized, /QUEUED/);
  assert.doesNotMatch(serialized, /shirone-reading-concurrency-v1|concurrency_ref|lease_owner/);
  assert.equal(actions.filter((value) => value.Put?.TableName === "jobs").length, 1);
});

test("worker claim acquires concurrency and transitions only the expected job version", async () => {
  const sender = new Sender(); const store = new api.DynamoAsyncReadingPersistence(sender, config);
  const job = { jobRef: input.jobRef, historyId: input.historyId, requestRef: input.requestRef, fingerprint: input.fingerprint, mode: "light", state: "QUEUED", version: 1, ownerUserId: input.userId, ownerRef: input.ownerRef, canonicalInput: input.canonicalInput, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(), expiresAt: 2_000_000_000, attemptCount: 0 };
  const result = await store.claim({ job, workerMode: "light", leaseOwner: "lease-owner-fixture", now: input.now });
  assert.equal(result.kind, "claimed");
  const serialized = JSON.stringify(sender.transactions[0]);
  assert.match(serialized, /shirone-reading-concurrency-v1/);
  assert.match(serialized, /IN_PROGRESS/);
  assert.match(serialized, /lease-owner-fixture/);
});

test("deep acceptance reserves the monthly quota atomically without taking concurrency", async () => {
  const sender = new Sender();
  const store = new api.DynamoAsyncReadingPersistence(sender, deepConfig, () => "deep-reservation-fixture");
  const deepInput = {
    ...input,
    membershipTier: "premium",
    mode: "deep",
    canonicalInput: { ...input.canonicalInput, resolvedMode: "deep" },
  };
  assert.equal(await store.accept(deepInput), "accepted");
  const actions = sender.transactions[0];
  const serialized = JSON.stringify(actions);
  assert.match(serialized, /deep-quota/);
  assert.match(serialized, /deep-reservation-fixture/);
  assert.match(serialized, /subscription_status/);
  assert.match(serialized, /deep_enabled/);
  assert.match(serialized, /RESERVED/);
  assert.doesNotMatch(serialized, /shirone-reading-concurrency-v1|concurrency_ref|lease_owner/);
  assert.equal(actions.filter((value) => value.ConditionCheck?.TableName === "users").length, 1);
  assert.equal(actions.filter((value) => value.Put?.TableName === "deep-quota").length, 1);
});

test("expired IN_PROGRESS claim uses a conditional takeover and a new owned concurrency lease", async () => {
  const sender = new Sender();
  const store = new api.DynamoAsyncReadingPersistence(sender, config);
  const expired = {
    jobRef: input.jobRef,
    historyId: input.historyId,
    requestRef: input.requestRef,
    fingerprint: input.fingerprint,
    mode: "light",
    state: "IN_PROGRESS",
    version: 7,
    ownerUserId: input.userId,
    ownerRef: input.ownerRef,
    canonicalInput: input.canonicalInput,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    expiresAt: 2_000_000_000,
    attemptCount: 2,
    leaseOwner: "expired-owner",
    leaseExpiresAt: Math.floor(input.now.getTime() / 1000) - 1,
  };
  const result = await store.claim({ job: expired, workerMode: "light", leaseOwner: "replacement-owner", now: input.now });
  assert.equal(result.kind, "claimed");
  assert.equal(result.job.attemptCount, 3);
  assert.equal(result.job.leaseOwner, "replacement-owner");
  const jobUpdate = sender.transactions[0].find((value) => value.Update?.TableName === "jobs").Update;
  assert.match(jobUpdate.ConditionExpression, /lease_expires_at<=:epoch/);
  assert.equal(jobUpdate.ExpressionAttributeValues[":version"].N, "7");
});

function terminalSender(quotaRef) {
  return {
    transactions: [],
    async send(command) {
      if (command.constructor.name === "GetItemCommand") {
        if (command.input.TableName === "rate") {
          return { Item: {
            rate_limit_ref: { S: "concurrency-ref" },
            schema_version: { S: "shirone-reading-concurrency-v1" },
            scope: { S: "deep" },
            limit: { N: "1" },
            reservations: { L: [{ M: {
              request_ref: { S: input.requestRef },
              reservation_id: { S: "concurrency-reservation" },
              reserved_at: { S: input.now.toISOString() },
              expires_at: { N: String(Math.floor(input.now.getTime() / 1000) + 180) },
            } }] },
            version: { N: "4" },
            created_at: { S: input.now.toISOString() },
            updated_at: { S: input.now.toISOString() },
            expires_at: { N: "2000000000" },
          } };
        }
        if (command.input.TableName === "deep-quota") {
          return { Item: {
            quota_ref: { S: quotaRef },
            schema_version: { S: "shirone-deep-quota-v1" },
            period_key: { S: "2026-07" },
            limit: { N: "3" },
            used: { N: "0" },
            reservations: { L: [{ M: {
              reservation_id: { S: "deep-reservation" },
              request_ref: { S: input.requestRef },
              history_id: { S: input.historyId },
              reserved_at: { S: input.now.toISOString() },
              expires_at: { N: String(Math.floor(input.now.getTime() / 1000) + 600) },
            } }] },
            version: { N: "2" },
            created_at: { S: input.now.toISOString() },
          } };
        }
      }
      if (command.constructor.name === "TransactWriteItemsCommand") {
        this.transactions.push(command.input.TransactItems);
        return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}

function terminalJob(quotaRef) {
  return {
    jobRef: input.jobRef,
    historyId: input.historyId,
    requestRef: input.requestRef,
    fingerprint: input.fingerprint,
    mode: "deep",
    state: "IN_PROGRESS",
    version: 5,
    ownerUserId: input.userId,
    ownerRef: input.ownerRef,
    canonicalInput: { ...input.canonicalInput, resolvedMode: "deep" },
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    expiresAt: 2_000_000_000,
    attemptCount: 1,
    leaseOwner: "lease-owner-fixture",
    leaseExpiresAt: Math.floor(input.now.getTime() / 1000) + 360,
    concurrencyRef: "concurrency-ref",
    concurrencyReservationId: "concurrency-reservation",
    concurrencyExpiresAt: Math.floor(input.now.getTime() / 1000) + 180,
    deepReservation: {
      quotaRef,
      periodKey: "2026-07",
      reservationId: "deep-reservation",
      reservationExpiresAt: Math.floor(input.now.getTime() / 1000) + 600,
    },
    stagedResult: {
      resolved_mode: "deep",
      status: "completed",
      rendering_status: "rendered",
      result: { title: "fixture", sections: [], one_step: "fixture", avoid_hint: "fixture" },
    },
  };
}

test("deep terminal transactions consume or release quota and release owned concurrency exactly once", async () => {
  const quotaRef = api.createDeepQuotaRef({ userId: input.userId, periodKey: "2026-07", secret: deepConfig.deepQuota.hashSecret });
  const completedSender = terminalSender(quotaRef);
  const completedStore = new api.DynamoAsyncReadingPersistence(completedSender, deepConfig);
  await completedStore.complete({ job: terminalJob(quotaRef), now: input.now });
  const completed = JSON.stringify(completedSender.transactions[0]);
  assert.match(completed, /COMPLETED/);
  assert.match(completed, /"used":{"N":"1"}/);
  assert.match(completed, /"reservations":{"L":\[\]}/);
  assert.match(completed, /concurrency-reservation/);

  const failedSender = terminalSender(quotaRef);
  const failedStore = new api.DynamoAsyncReadingPersistence(failedSender, deepConfig);
  await failedStore.fail({ job: terminalJob(quotaRef), category: "generation_failed", now: input.now });
  const failed = JSON.stringify(failedSender.transactions[0]);
  assert.match(failed, /FAILED/);
  assert.match(failed, /"used":{"N":"0"}/);
  assert.match(failed, /"reservations":{"L":\[\]}/);
  assert.match(failed, /concurrency-reservation/);
});
