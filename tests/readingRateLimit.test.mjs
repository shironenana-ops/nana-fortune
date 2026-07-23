import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?rate=${Date.now()}`);

const SECRET = "fixture-only-rate-limit-secret-32-characters-minimum";
const NOW = new Date("2026-07-23T00:00:05.000Z");
const requestRef = "a".repeat(64);
const policyValues = {
  "free/free": { max: 2, windowSeconds: 60 },
  "light/free": { max: 3, windowSeconds: 60 },
  "light/light": { max: 2, windowSeconds: 60 },
  "premium/free": { max: 4, windowSeconds: 60 },
  "premium/light": { max: 3, windowSeconds: 60 },
  "premium/deep": { max: 2, windowSeconds: 60 },
};
const config = {
  tableName: "fixture-rate-limit",
  hashSecret: SECRET,
  policies: policyValues,
  concurrency: { light: 1, deep: 1, leaseSeconds: 120 },
};
const validEnv = () => ({
  READING_RATE_LIMIT_TABLE_NAME: "fixture-rate-limit",
  READING_IDEMPOTENCY_HASH_SECRET: SECRET,
  READING_RATE_LIMIT_FREE_FREE_MAX: "2",
  READING_RATE_LIMIT_FREE_FREE_WINDOW_SECONDS: "60",
  READING_RATE_LIMIT_LIGHT_FREE_MAX: "3",
  READING_RATE_LIMIT_LIGHT_FREE_WINDOW_SECONDS: "60",
  READING_RATE_LIMIT_LIGHT_LIGHT_MAX: "2",
  READING_RATE_LIMIT_LIGHT_LIGHT_WINDOW_SECONDS: "60",
  READING_RATE_LIMIT_PREMIUM_FREE_MAX: "4",
  READING_RATE_LIMIT_PREMIUM_FREE_WINDOW_SECONDS: "60",
  READING_RATE_LIMIT_PREMIUM_LIGHT_MAX: "3",
  READING_RATE_LIMIT_PREMIUM_LIGHT_WINDOW_SECONDS: "60",
  READING_RATE_LIMIT_PREMIUM_DEEP_MAX: "2",
  READING_RATE_LIMIT_PREMIUM_DEEP_WINDOW_SECONDS: "60",
  READING_CONCURRENCY_LIGHT_LIMIT: "1",
  READING_CONCURRENCY_DEEP_LIMIT: "1",
  READING_CONCURRENCY_LEASE_SECONDS: "120",
});

const clone = (value) => structuredClone(value);
class MemorySender {
  constructor() { this.items = new Map(); }
  async send(command) {
    if (command.constructor.name !== "GetItemCommand") throw new Error("unexpected command");
    return { Item: clone(this.items.get(command.input.Key.rate_limit_ref.S)) };
  }
  apply(actions) {
    const next = new Map([...this.items].map(([key, value]) => [key, clone(value)]));
    for (const action of actions) {
      const put = action.Put;
      assert.ok(put, "rate limiter only prepares atomic Put actions");
      const key = put.Item.rate_limit_ref.S;
      const current = next.get(key);
      if (put.ConditionExpression.includes("attribute_not_exists")) assert.equal(current, undefined);
      else assert.equal(current?.version?.N, put.ExpressionAttributeValues[":version"].N);
      next.set(key, clone(put.Item));
    }
    this.items = next;
  }
}

test("policy configuration requires every explicit value and preserves no production default", () => {
  const parsed = api.readReadingRateLimitConfig(validEnv());
  assert.deepEqual(parsed.policies["premium/deep"], { max: 2, windowSeconds: 60 });
  for (const [key, value] of [
    ["READING_RATE_LIMIT_TABLE_NAME", ""],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", ""],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "0"],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "-1"],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "1.5"],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "not-a-number"],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "9007199254740992"],
    ["READING_RATE_LIMIT_FREE_FREE_MAX", "10001"],
    ["READING_RATE_LIMIT_FREE_FREE_WINDOW_SECONDS", "86401"],
    ["READING_CONCURRENCY_LIGHT_LIMIT", "2"],
    ["READING_CONCURRENCY_DEEP_LIMIT", "0"],
  ]) {
    const env = validEnv(); env[key] = value;
    assert.throws(() => api.readReadingRateLimitConfig(env), (error) => error.code === "READING_RATE_LIMIT_NOT_CONFIGURED");
  }
  assert.throws(() => api.readReadingRateLimitConfig({ ...validEnv(), READING_IDEMPOTENCY_HASH_SECRET: "short" }));
  assert.throws(() => api.ratePolicyKey("free", "deep"), (error) => error.code === "READING_RATE_LIMIT_INCONSISTENT");
});

test("HMAC references are stable, scoped, domain separated, and never contain the user id", () => {
  const userId = "fixture-user-sensitive-value";
  const base = { userId, tier: "premium", mode: "light", windowStart: 123, secret: SECRET };
  const first = api.createRateWindowRef(base);
  assert.equal(first, api.createRateWindowRef(base));
  assert.doesNotMatch(first, new RegExp(userId));
  assert.notEqual(first, api.createRateWindowRef({ ...base, userId: `${userId}-2` }));
  assert.notEqual(first, api.createRateWindowRef({ ...base, tier: "light" }));
  assert.notEqual(first, api.createRateWindowRef({ ...base, mode: "free" }));
  assert.notEqual(first, api.createRateWindowRef({ ...base, windowStart: 124 }));
  assert.notEqual(first, api.createConcurrencyRef({ userId, mode: "light", secret: SECRET }));
});

test("fixed window counts successful acquisitions, rejects limit+1, and rolls over", async () => {
  const sender = new MemorySender();
  const limiter = new api.DynamoReadingRateLimiter(sender, config);
  for (let index = 0; index < 2; index += 1) {
    const acquired = await limiter.prepareAcquire({ userId: "user-a", tier: "free", mode: "free", requestRef: String(index).padStart(64, "a"), ownerToken: `owner-a-${index}`, now: NOW });
    sender.apply(acquired.actions);
  }
  await assert.rejects(
    limiter.prepareAcquire({ userId: "user-a", tier: "free", mode: "free", requestRef: "b".repeat(64), ownerToken: "owner-a-denied", now: NOW }),
    (error) => error.code === "READING_RATE_LIMIT_REACHED" && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0,
  );
  const rolled = await limiter.prepareAcquire({ userId: "user-a", tier: "free", mode: "free", requestRef: "c".repeat(64), ownerToken: "owner-a-rolled", now: new Date(NOW.getTime() + 60_000) });
  sender.apply(rolled.actions);
});

test("light concurrency denies another request, releases only the owner, and then permits the next", async () => {
  const sender = new MemorySender();
  let serial = 0;
  const limiter = new api.DynamoReadingRateLimiter(sender, config);
  const first = await limiter.prepareAcquire({ userId: "user-b", tier: "light", mode: "light", requestRef, ownerToken: `reservation-${++serial}`, now: NOW });
  sender.apply(first.actions);
  await assert.rejects(
    limiter.prepareAcquire({ userId: "user-b", tier: "light", mode: "light", requestRef: "b".repeat(64), ownerToken: `reservation-${++serial}`, now: NOW }),
    (error) => error.code === "READING_CONCURRENT_LIMIT_REACHED" && error.retryAfter > 0,
  );
  await assert.rejects(
    limiter.prepareRelease({ ...first.reservation, concurrencyReservationId: "not-owner" }, requestRef, NOW),
    (error) => error.code === "READING_RATE_LIMIT_INCONSISTENT",
  );
  const release = await limiter.prepareRelease(first.reservation, requestRef, NOW);
  sender.apply([release]);
  const second = await limiter.prepareAcquire({ userId: "user-b", tier: "light", mode: "light", requestRef: "b".repeat(64), ownerToken: `reservation-${++serial}`, now: NOW });
  sender.apply(second.actions);
});

test("expired concurrency lease is lazily reclaimed and malformed state fails closed", async () => {
  const sender = new MemorySender();
  let serial = 0;
  const limiter = new api.DynamoReadingRateLimiter(sender, config);
  const first = await limiter.prepareAcquire({ userId: "user-c", tier: "premium", mode: "deep", requestRef, ownerToken: `reservation-${++serial}`, now: NOW });
  sender.apply(first.actions);
  const reclaimed = await limiter.prepareAcquire({ userId: "user-c", tier: "premium", mode: "deep", requestRef: "d".repeat(64), ownerToken: `reservation-${++serial}`, now: new Date(NOW.getTime() + 121_000) });
  assert.equal(reclaimed.reservation.concurrencyExpiredReclaimed, true);
  sender.apply(reclaimed.actions);
  const concurrencyItem = [...sender.items.values()].find((item) => item.schema_version?.S === "shirone-reading-concurrency-v1");
  concurrencyItem.limit = { N: "2" };
  await assert.rejects(
    limiter.prepareAcquire({ userId: "user-c", tier: "premium", mode: "deep", requestRef: "e".repeat(64), ownerToken: `reservation-${++serial}`, now: new Date(NOW.getTime() + 242_000) }),
    (error) => error.code === "READING_RATE_LIMIT_INCONSISTENT",
  );
});

test("Dynamo failure maps to the safe unavailable error", async () => {
  const limiter = new api.DynamoReadingRateLimiter({ send: async () => { throw new Error("sensitive provider detail"); } }, config);
  await assert.rejects(
    limiter.prepareAcquire({ userId: "user-d", tier: "free", mode: "free", requestRef, ownerToken: "owner-d", now: NOW }),
    (error) => error.code === "READING_RATE_LIMIT_UNAVAILABLE" && error.message === "READING_RATE_LIMIT_UNAVAILABLE",
  );
});

test("HTTP mapping is fixed, safe, and emits only an integer Retry-After", () => {
  const requestId = "fixture-request-id";
  const rate = api.toSafeErrorResponse(new api.ServerFoundationError("READING_RATE_LIMIT_REACHED", { retryAfter: 42 }), requestId);
  assert.equal(rate.status, 429); assert.equal(rate.retryAfter, 42);
  assert.deepEqual(Object.keys(rate.body.error).sort(), ["code", "message", "request_id"]);
  assert.equal(api.toSafeErrorResponse(new api.ServerFoundationError("READING_CONCURRENT_LIMIT_REACHED", { retryAfter: 5 }), requestId).status, 429);
  assert.equal(api.toSafeErrorResponse(new api.ServerFoundationError("READING_RATE_LIMIT_NOT_CONFIGURED"), requestId).status, 500);
  assert.equal(api.toSafeErrorResponse(new api.ServerFoundationError("READING_RATE_LIMIT_UNAVAILABLE"), requestId).status, 503);
  assert.equal(api.toSafeErrorResponse(new api.ServerFoundationError("READING_RATE_LIMIT_INCONSISTENT"), requestId).status, 503);
});

test("new persistence attempts compose rate, concurrency, and idempotency in one transaction", async () => {
  const commands = [];
  const sender = { send: async (command) => {
    commands.push(command);
    if (command.constructor.name === "GetItemCommand") return {};
    if (command.constructor.name === "TransactWriteItemsCommand") return {};
    throw new Error("unexpected command");
  } };
  const persistence = new api.DynamoReadingPersistence(sender, {
    idempotencyTable: "fixture-idempotency", historyTable: "fixture-history", hashSecret: SECRET,
    leaseSeconds: 120, ttlSeconds: 3600, rateLimit: config,
  }, (() => { let value = 0; return () => `uuid-${++value}`; })());
  const result = await persistence.begin({ requestRef, fingerprint: "f".repeat(64), userId: "raw-user-must-not-be-stored", membershipTier: "light", resolvedMode: "light", readingDate: "2026-07-23", now: NOW });
  assert.equal(result.kind, "acquired");
  const transaction = commands.find((command) => command.constructor.name === "TransactWriteItemsCommand").input.TransactItems;
  assert.equal(transaction.length, 3);
  const serialized = JSON.stringify(transaction);
  assert.doesNotMatch(serialized, /raw-user-must-not-be-stored/u);
  assert.match(serialized, /shirone-reading-rate-window-v1/u);
  assert.match(serialized, /shirone-reading-concurrency-v1/u);
  assert.match(serialized, /shirone-reading-idempotency-v1/u);
});

test("deep begins with membership, monthly quota, rate, concurrency, and idempotency in one transaction", async () => {
  const commands = [];
  const sender = { send: async (command) => {
    commands.push(command);
    if (command.constructor.name === "GetItemCommand") return {};
    if (command.constructor.name === "TransactWriteItemsCommand") return {};
    throw new Error("unexpected command");
  } };
  let value = 0;
  const persistence = new api.DynamoReadingPersistence(sender, {
    idempotencyTable: "fixture-idempotency", historyTable: "fixture-history", hashSecret: SECRET,
    leaseSeconds: 120, ttlSeconds: 3600, rateLimit: config,
    deepQuota: { tableName: "fixture-deep", usersTableName: "fixture-users", hashSecret: SECRET, reservationSeconds: 600 },
  }, () => `uuid-${++value}`);
  const result = await persistence.begin({ requestRef, fingerprint: "f".repeat(64), userId: "raw-deep-user", membershipTier: "premium", resolvedMode: "deep", readingDate: "2026-07-23", now: NOW });
  assert.equal(result.kind, "acquired");
  const transaction = commands.find((command) => command.constructor.name === "TransactWriteItemsCommand").input.TransactItems;
  assert.equal(transaction.length, 5);
  assert.ok(transaction[0].ConditionCheck);
  const serialized = JSON.stringify(transaction);
  const rateItems = transaction.filter((action) => action.Put?.TableName === config.tableName);
  assert.doesNotMatch(JSON.stringify(rateItems), /raw-deep-user/u);
  assert.match(serialized, /shirone-deep-quota-v1/u);
  assert.match(serialized, /shirone-reading-rate-window-v1/u);
  assert.match(serialized, /shirone-reading-concurrency-v1/u);
  assert.match(serialized, /shirone-reading-idempotency-v1/u);
});

test("completion and failure release the owned concurrency slot atomically", async () => {
  const concurrencyRef = "c".repeat(64);
  const rateControl = { concurrencyRef, concurrencyReservationId: "owner-token", concurrencyExpiresAt: 1_900_000_000, rateRef: "r".repeat(64), rateWindowEnd: 1_900_000_000 };
  const concurrencyItem = {
    rate_limit_ref: { S: concurrencyRef }, schema_version: { S: "shirone-reading-concurrency-v1" }, scope: { S: "light" }, limit: { N: "1" },
    reservations: { L: [{ M: { request_ref: { S: requestRef }, reservation_id: { S: "owner-token" }, reserved_at: { S: NOW.toISOString() }, expires_at: { N: "1900000000" } } }] },
    version: { N: "1" }, created_at: { S: NOW.toISOString() }, updated_at: { S: NOW.toISOString() }, expires_at: { N: "1900000120" },
  };
  const reservation = { requestRef, fingerprint: "f".repeat(64), ownerToken: "owner-token", historyId: "history-id", readingDate: "2026-07-23", resolvedMode: "light", createdAt: NOW.toISOString(), rateControl };
  const make = () => {
    const commands = [];
    const sender = { send: async (command) => {
      commands.push(command);
      if (command.constructor.name === "GetItemCommand") return { Item: clone(concurrencyItem) };
      if (command.constructor.name === "TransactWriteItemsCommand") return {};
      throw new Error("unexpected command");
    } };
    return { commands, persistence: new api.DynamoReadingPersistence(sender, { idempotencyTable: "fixture-idempotency", historyTable: "fixture-history", hashSecret: SECRET, leaseSeconds: 120, ttlSeconds: 3600, rateLimit: config }) };
  };
  const completed = make();
  await completed.persistence.complete({ reservation, userId: "user-e", response: { resolved_mode: "light", status: "completed", rendering_status: "rendered", result: { title: "fixture", sections: [], one_step: "one", avoid_hint: "avoid" } }, now: NOW });
  const completeTransaction = completed.commands.find((command) => command.constructor.name === "TransactWriteItemsCommand").input.TransactItems;
  assert.equal(completeTransaction.length, 3);
  assert.deepEqual(completeTransaction[2].Put.Item.reservations, { L: [] });

  const failed = make();
  await failed.persistence.fail({ reservation, now: NOW, category: "generation_failed" });
  const failTransaction = failed.commands.find((command) => command.constructor.name === "TransactWriteItemsCommand").input.TransactItems;
  assert.equal(failTransaction.length, 2);
  assert.deepEqual(failTransaction[1].Put.Item.reservations, { L: [] });
});
