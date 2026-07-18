import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?deep=${Date.now()}`);

const QUOTA_SECRET = "fixture-only-deep-quota-secret-32-characters-minimum";
const config = {
  idempotencyTable: "fixture-idempotency",
  historyTable: "fixture-history",
  hashSecret: "fixture-only-idempotency-secret-32-characters-minimum",
  leaseSeconds: 90,
  ttlSeconds: 604800,
  deepQuota: {
    tableName: "fixture-deep-quota",
    usersTableName: "fixture-users",
    hashSecret: QUOTA_SECRET,
    reservationSeconds: 600,
  },
};

const clone = (value) => structuredClone(value);
const s = (value) => ({ S: value });

class FakeDynamo {
  constructor() {
    this.tables = new Map([
      [config.idempotencyTable, new Map()],
      [config.historyTable, new Map()],
      [config.deepQuota.tableName, new Map()],
      [config.deepQuota.usersTableName, new Map([["fixture-user", {
        user_id: s("fixture-user"), plan: s("premium"), subscription_status: s("active"), deep_enabled: { BOOL: true },
      }]])],
    ]);
    this.commands = [];
  }
  key(table, key) {
    if (table === config.historyTable) return `${key.user_id.S}|${key.history_id.S}`;
    return key.request_ref?.S ?? key.quota_ref?.S ?? key.user_id?.S;
  }
  async send(command) {
    const input = clone(command.input);
    this.commands.push({ name: command.constructor.name, input });
    if (command.constructor.name === "GetItemCommand") {
      return { Item: clone(this.tables.get(input.TableName)?.get(this.key(input.TableName, input.Key))) };
    }
    if (command.constructor.name === "PutItemCommand") {
      const table = this.tables.get(input.TableName); const key = this.key(input.TableName, input.Item);
      if (table.has(key)) throw Object.assign(new Error("hidden"), { name: "ConditionalCheckFailedException" });
      table.set(key, clone(input.Item)); return {};
    }
    if (command.constructor.name === "UpdateItemCommand") {
      this.applyUpdate(this.tables, input); return {};
    }
    if (command.constructor.name !== "TransactWriteItemsCommand") throw new Error("unsupported fake command");
    const next = new Map([...this.tables].map(([name, table]) => [name, new Map([...table].map(([key, item]) => [key, clone(item)]))]));
    const reasons = input.TransactItems.map(() => ({ Code: "None" }));
    try {
      input.TransactItems.forEach((action, index) => {
        if (action.ConditionCheck) {
          const value = action.ConditionCheck;
          const item = next.get(value.TableName)?.get(this.key(value.TableName, value.Key));
          const isUser = value.TableName === config.deepQuota.usersTableName;
          const ok = isUser
            ? item?.plan?.S === "premium" && item?.subscription_status?.S === "active" && item?.deep_enabled?.BOOL === true
            : !!item && Number(item.version?.N) === Number(value.ExpressionAttributeValues[":version"].N) &&
              item.reservations.L.some((entry) => entry.M.reservation_id.S === value.ExpressionAttributeValues[":reservation"].S);
          if (!ok) { reasons[index] = { Code: "ConditionalCheckFailed" }; throw new Error("cancel"); }
        } else if (action.Put) {
          const value = action.Put; const table = next.get(value.TableName); const key = this.key(value.TableName, value.Item); const previous = table.get(key);
          if (value.ConditionExpression.includes("attribute_not_exists") && previous) { reasons[index] = { Code: "ConditionalCheckFailed" }; throw new Error("cancel"); }
          if (value.ExpressionAttributeValues && Number(previous?.version?.N) !== Number(value.ExpressionAttributeValues[":version"].N)) { reasons[index] = { Code: "ConditionalCheckFailed" }; throw new Error("cancel"); }
          table.set(key, clone(value.Item));
        } else if (action.Update) {
          this.applyUpdate(next, action.Update);
        }
      });
    } catch {
      throw Object.assign(new Error("hidden transaction"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    }
    this.tables = next;
    return {};
  }
  applyUpdate(tables, input) {
    const table = tables.get(input.TableName); const key = this.key(input.TableName, input.Key); const item = table.get(key);
    if (!item) throw new Error("missing fake item");
    const values = input.ExpressionAttributeValues;
    if (values[":completed"]) {
      item.state = values[":completed"]; item.completed_at = values[":now"]; item.updated_at = values[":now"];
      if (values[":consumed"]) item.deep_reservation_state = values[":consumed"];
      delete item.owner_token;
    } else if (values[":released"] || values[":category"]?.S === "deep_reservation_expired") {
      item.state = values[":failed"]; item.deep_reservation_state = values[":released"];
      item.failure_category = values[":category"]; item.updated_at = values[":now"]; delete item.owner_token;
    } else if (values[":reservation"]) {
      item.state = values[":progress"]; item.owner_token = values[":owner"]; item.updated_at = values[":updated"];
      item.lease_expires_at = values[":lease"]; item.expires_at = values[":ttl"];
      item.deep_quota_schema_version = values[":schema"]; item.deep_period_key = values[":period"];
      item.deep_reservation_id = values[":reservation"]; item.deep_reservation_state = values[":reserved"];
      item.deep_reservation_expires_at = values[":reservationExpiry"];
      delete item.failure_category;
    }
    table.set(key, item);
  }
}

function uuidFactory() { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`; }
function begin(repo, requestRef, now, userId = "fixture-user") {
  return repo.begin({ requestRef, fingerprint: "b".repeat(64), userId, resolvedMode: "deep", readingDate: "2026-07-18", now });
}
function response() {
  return { request_id: "public-request", resolved_mode: "deep", status: "completed", rendering_status: "rendered", result: { title: "架空結果", sections: [], one_step: "一歩", avoid_hint: "注意" } };
}

test("JST暦月、quota_ref、remaining、設定値を固定仕様で扱う", () => {
  assert.equal(api.getJstPeriodKey(new Date("2026-07-31T14:59:59Z")), "2026-07");
  assert.equal(api.getJstPeriodKey(new Date("2026-07-31T15:00:00Z")), "2026-08");
  assert.equal(api.getJstPeriodKey(new Date("2026-12-31T15:00:00Z")), "2027-01");
  const a = api.createDeepQuotaRef({ userId: "fixture-user", periodKey: "2026-07", secret: QUOTA_SECRET });
  assert.equal(a, api.createDeepQuotaRef({ userId: "fixture-user", periodKey: "2026-07", secret: QUOTA_SECRET }));
  assert.notEqual(a, api.createDeepQuotaRef({ userId: "other-user", periodKey: "2026-07", secret: QUOTA_SECRET }));
  assert.notEqual(a, api.createDeepQuotaRef({ userId: "fixture-user", periodKey: "2026-08", secret: QUOTA_SECRET }));
  assert.equal(a.length, 64); assert.doesNotMatch(a, /fixture-user/);
  assert.deepEqual(api.readDeepQuotaConfig({ READING_DEEP_QUOTA_TABLE_NAME: "quota", USERS_TABLE_NAME: "users", READING_DEEP_QUOTA_HASH_SECRET: QUOTA_SECRET }), { tableName: "quota", usersTableName: "users", hashSecret: QUOTA_SECRET, reservationSeconds: 600 });
  for (const invalid of [{}, { READING_DEEP_QUOTA_TABLE_NAME: " " }, { READING_DEEP_QUOTA_TABLE_NAME: "quota", USERS_TABLE_NAME: "users", READING_DEEP_QUOTA_HASH_SECRET: "short" }, { READING_DEEP_QUOTA_TABLE_NAME: "quota", USERS_TABLE_NAME: "users", READING_DEEP_QUOTA_HASH_SECRET: `${QUOTA_SECRET}\n` }, { READING_DEEP_QUOTA_TABLE_NAME: "quota", USERS_TABLE_NAME: "users", READING_DEEP_QUOTA_HASH_SECRET: "x".repeat(4097) }]) assert.throws(() => api.readDeepQuotaConfig(invalid), /READING_DEEP_QUOTA_CONFIG_ERROR/);
  for (const value of ["", " ", "0", "119", "1801", "1.5", "1e3", "-1", "999999999999999999999"]) assert.throws(() => api.readDeepQuotaConfig({ READING_DEEP_QUOTA_TABLE_NAME: "quota", USERS_TABLE_NAME: "users", READING_DEEP_QUOTA_HASH_SECRET: QUOTA_SECRET, READING_DEEP_RESERVATION_SECONDS: value }), /READING_DEEP_QUOTA_CONFIG_ERROR/);
  assert.deepEqual([0, 1, 2, 3, 4].map((used) => api.calculateDeepRemaining({ used, activeReservations: used === 1 ? 1 : 0 })), [3, 1, 1, 0, 0]);
});

test("deep新規予約はusers・quota・idempotencyを原子的に確保し4件目を拒否する", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory()); const now = new Date("2026-07-18T00:00:00Z");
  const acquired = [];
  for (let index = 0; index < 3; index += 1) acquired.push(await begin(repo, String(index + 1).repeat(64), now));
  await assert.rejects(() => begin(repo, "4".repeat(64), now), /READING_DEEP_MONTHLY_LIMIT_REACHED/);
  assert.ok(acquired.every((value) => value.kind === "acquired" && value.reservation.deep));
  const quota = [...fake.tables.get(config.deepQuota.tableName).values()][0];
  assert.equal(quota.limit.N, "3"); assert.equal(quota.used.N, "0"); assert.equal(quota.reservations.L.length, 3); assert.equal(quota.version.N, "3");
  const firstTransaction = fake.commands.find((value) => value.name === "TransactWriteItemsCommand").input;
  assert.equal(firstTransaction.TransactItems.length, 3);
  assert.ok(firstTransaction.TransactItems[0].ConditionCheck);
  const serialized = JSON.stringify(firstTransaction);
  assert.doesNotMatch(JSON.stringify(firstTransaction.TransactItems[1].Put.Item), /fixture-user|架空結果|birth|question|Idempotency-Key|stripe/i);
  assert.doesNotMatch(serialized, /架空結果|birth|question|Idempotency-Key|stripe/i);
});

test("権利のtransaction条件が失効した場合は固定403で予約を残さない", async () => {
  const fake = new FakeDynamo(); fake.tables.get(config.deepQuota.usersTableName).get("fixture-user").deep_enabled = { BOOL: false };
  const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory());
  await assert.rejects(() => begin(repo, "a".repeat(64), new Date("2026-07-18T00:00:00Z")), /READING_DEEP_NOT_ENTITLED/);
  assert.equal(fake.tables.get(config.deepQuota.tableName).size, 0); assert.equal(fake.tables.get(config.idempotencyTable).size, 0);
});

test("同一keyの追加予約を作らずactive処理中を返す", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory()); const now = new Date("2026-07-18T00:00:00Z");
  assert.equal((await begin(repo, "a".repeat(64), now)).kind, "acquired");
  assert.equal((await begin(repo, "a".repeat(64), now)).kind, "in_progress");
  const quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.reservations.L.length, 1);
});

test("同一userの異なる4 requestを並行開始しても予約成功は最大3件", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory()); const now = new Date("2026-07-18T00:00:00Z");
  const results = await Promise.allSettled(["1", "2", "3", "4"].map((value) => begin(repo, value.repeat(64), now)));
  assert.equal(results.filter((value) => value.status === "fulfilled" && value.value.kind === "acquired").length, 3);
  const denied = results.find((value) => value.status === "rejected"); assert.match(String(denied?.reason), /READING_DEEP_MONTHLY_LIMIT_REACHED/);
  const quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.reservations.L.length, 3);
});

test("deep成功はhistory・idempotency・quota消費を同一transactionで確定しreplayで再消費しない", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory()); const now = new Date("2026-07-18T00:00:00Z");
  const begun = await begin(repo, "a".repeat(64), now); assert.equal(begun.kind, "acquired");
  const stored = await repo.complete({ reservation: begun.reservation, userId: "fixture-user", response: response(), now: new Date("2026-07-18T00:00:30Z") });
  assert.equal(stored.status, "completed");
  const completion = fake.commands.filter((value) => value.name === "TransactWriteItemsCommand").at(-1).input;
  assert.equal(completion.TransactItems.length, 3);
  const quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.used.N, "1"); assert.equal(quota.reservations.L.length, 0);
  const replay = await begin(repo, "a".repeat(64), new Date("2026-07-18T00:01:00Z")); assert.equal(replay.kind, "replay"); assert.equal(replay.history.result.title, "架空結果");
  assert.equal([...fake.tables.get(config.deepQuota.tableName).values()][0].used.N, "1");
});

test("deep生成失敗はidempotencyとquotaを同一transactionで解放しFAILED retryは1枠だけ再予約する", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory()); const now = new Date("2026-07-18T00:00:00Z");
  const begun = await begin(repo, "c".repeat(64), now); assert.equal(begun.kind, "acquired");
  await repo.fail({ reservation: begun.reservation, now: new Date("2026-07-18T00:00:30Z"), category: "generation_failed" });
  let quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.used.N, "0"); assert.equal(quota.reservations.L.length, 0);
  const retried = await begin(repo, "c".repeat(64), new Date("2026-07-18T00:01:00Z")); assert.equal(retried.kind, "acquired");
  quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.reservations.L.length, 1); assert.equal(retried.reservation.historyId, begun.reservation.historyId);
});

test("月またぎは開始月quotaを消費し新月requestは別itemへ予約する", async () => {
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, config, uuidFactory());
  const july = await begin(repo, "d".repeat(64), new Date("2026-07-31T14:59:50Z")); assert.equal(july.reservation.deep.periodKey, "2026-07");
  await repo.complete({ reservation: july.reservation, userId: "fixture-user", response: response(), now: new Date("2026-07-31T15:00:10Z") });
  const august = await begin(repo, "e".repeat(64), new Date("2026-07-31T15:00:20Z")); assert.equal(august.reservation.deep.periodKey, "2026-08");
  assert.equal(fake.tables.get(config.deepQuota.tableName).size, 2);
});

test("expired reservationは対応idempotencyと同一transactionで回収して新予約を作る", async () => {
  const short = { ...config, deepQuota: { ...config.deepQuota, reservationSeconds: 120 } };
  const fake = new FakeDynamo(); const repo = new api.DynamoReadingPersistence(fake, short, uuidFactory());
  await begin(repo, "f".repeat(64), new Date("2026-07-18T00:00:00Z"));
  const next = await begin(repo, "9".repeat(64), new Date("2026-07-18T00:02:01Z")); assert.equal(next.kind, "acquired");
  const expired = fake.tables.get(config.idempotencyTable).get("f".repeat(64)); assert.equal(expired.state.S, "FAILED"); assert.equal(expired.deep_reservation_state.S, "RELEASED_EXPIRED");
  const quota = [...fake.tables.get(config.deepQuota.tableName).values()][0]; assert.equal(quota.reservations.L.length, 1);
});
