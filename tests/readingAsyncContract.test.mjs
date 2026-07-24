import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?async-contract=${Date.now()}`);
const JOB = "11111111-1111-4111-8111-111111111111";
const HISTORY = "22222222-2222-4222-8222-222222222222";
const base = {
  requestId: "request-public-001", requestRef: "a".repeat(64), fingerprint: "b".repeat(64), userId: "fixture-user-private",
  membershipTier: "light", mode: "light", canonicalInput: { name: "架空 花子", birthDate: "1984-12-29", readingDate: "2026-07-24", resolvedMode: "light" }, now: new Date("2026-07-24T00:00:00Z"),
};

test("message schema is exactly version and opaque job_ref", () => {
  const body = api.serializeReadingJobMessage(JOB);
  assert.deepEqual(JSON.parse(body), { schema_version: "shirone-reading-job-message-v1", job_ref: JOB });
  assert.doesNotMatch(body, /fixture|name|birth|question|user|token|idempotency|history|queue/i);
  assert.deepEqual(api.parseReadingJobMessage(body), JSON.parse(body));
  for (const invalid of ["{}", "[]", "null", JSON.stringify({ schema_version: "shirone-reading-job-message-v1", job_ref: JOB, name: "x" }), JSON.stringify({ schema_version: "unknown", job_ref: JOB })]) {
    assert.throws(() => api.parseReadingJobMessage(invalid), (error) => error.code === "READING_JOB_INCONSISTENT");
  }
});

test("SQS adapter selects mode queue and sends no attributes with max-attempt independent body", async () => {
  const commands = [];
  const queue = new api.SqsReadingJobQueue({ send: async (command) => commands.push(command) }, { lightQueueUrl: "https://sqs.ap-northeast-1.amazonaws.com/000000000000/light", deepQueueUrl: "https://sqs.ap-northeast-1.amazonaws.com/000000000000/deep" });
  await queue.send("light", JOB);
  await queue.send("deep", JOB);
  assert.match(commands[0].input.QueueUrl, /\/light$/);
  assert.match(commands[1].input.QueueUrl, /\/deep$/);
  for (const command of commands) {
    assert.deepEqual(Object.keys(command.input).sort(), ["MessageBody", "QueueUrl"]);
    assert.deepEqual(Object.keys(JSON.parse(command.input.MessageBody)).sort(), ["job_ref", "schema_version"]);
  }
});

test("queue-first coordinator does not mutate persistence when queue fails", async () => {
  const calls = { accept: 0 };
  const service = api.createReadingAsyncAcceptance({
    queue: { send: async () => { throw new api.ServerFoundationError("READING_QUEUE_UNAVAILABLE"); } },
    persistence: { precheck: async () => ({ kind: "missing" }), accept: async () => { calls.accept += 1; return "accepted"; } },
    auditHashSecret: "fixture-only-audit-secret-32-characters-minimum", uuid: (() => { const values = [JOB, HISTORY]; return () => values.shift(); })(),
  });
  await assert.rejects(service.enqueue(base), (error) => error.code === "READING_QUEUE_UNAVAILABLE");
  assert.equal(calls.accept, 0);
});

test("queued replay skips queue and race loser returns winning reading_id", async () => {
  let reads = 0; let sends = 0;
  const persistence = {
    precheck: async () => (++reads === 1 ? { kind: "missing" } : { kind: "queued", historyId: "winner-history" }),
    accept: async () => "conflict",
  };
  const service = api.createReadingAsyncAcceptance({ queue: { send: async () => { sends += 1; } }, persistence, auditHashSecret: "fixture-only-audit-secret-32-characters-minimum", uuid: (() => { const values = [JOB, HISTORY]; return () => values.shift(); })() });
  const result = await service.enqueue(base);
  assert.deepEqual(result, { request_id: "request-public-001", reading_id: "winner-history", status: "queued" });
  assert.equal(sends, 1);
  const replay = api.createReadingAsyncAcceptance({ queue: { send: async () => { throw new Error("must not send"); } }, persistence: { precheck: async () => ({ kind: "in_progress", historyId: "winner-history" }) }, auditHashSecret: "fixture-only-audit-secret-32-characters-minimum" });
  assert.equal((await replay.enqueue(base)).reading_id, "winner-history");
});

test("failed replay and fingerprint conflict are fixed 409 errors", async () => {
  for (const [kind, code] of [["failed", "READING_JOB_FAILED"], ["conflict", "IDEMPOTENCY_CONFLICT"]]) {
    const service = api.createReadingAsyncAcceptance({ queue: { send: async () => {} }, persistence: { precheck: async () => ({ kind }) }, auditHashSecret: "fixture-only-audit-secret-32-characters-minimum" });
    await assert.rejects(service.enqueue(base), (error) => error.code === code);
  }
});
