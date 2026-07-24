import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?async-worker=${Date.now()}`);
const JOB_REF = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-24T00:01:00.000Z");
const message = (id, ageMs = 1_000, body = api.serializeReadingJobMessage(JOB_REF)) => ({ messageId: id, body, attributes: { SentTimestamp: String(NOW.getTime() - ageMs) } });
const job = (overrides = {}) => ({ jobRef: JOB_REF, historyId: "history-internal", requestRef: "a".repeat(64), fingerprint: "b".repeat(64), mode: "light", state: "QUEUED", version: 1, ownerUserId: "fixture-user-private", ownerRef: "c".repeat(64), canonicalInput: { name: "架空 花子", birthDate: "1984-12-29", readingDate: "2026-07-24", resolvedMode: "light" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expiresAt: 2_000_000_000, attemptCount: 0, ...overrides });
function reading() { return { plan: "light", title: "公開", todayMessage: "hidden", marginMessage: "hidden", oneStep: "一歩", avoidHint: "注意", audioScript: "hidden", sections: [{ id: "core", title: "本質", summary: "hidden", body: "本文" }], knowledgePayload: {}, historyPayloadV2: {}, iconHints: [], context: {} }; }
function setup(initialJob, options = {}) {
  const calls = { engine: 0, render: 0, claim: 0, stage: 0, complete: 0, fail: 0, requeue: 0 };
  const persistence = {
    readJob: async () => initialJob,
    claim: async ({ job: value, leaseOwner }) => { calls.claim += 1; return options.claim ?? { kind: "claimed", job: { ...value, state: "IN_PROGRESS", version: value.version + 1, leaseOwner, leaseExpiresAt: 2_000_000_000, attemptCount: value.attemptCount + 1 } }; },
    stageResult: async ({ job: value, result }) => { calls.stage += 1; if (options.stageError) throw new api.ServerFoundationError("READING_JOB_UNAVAILABLE"); return { ...value, stagedResult: result, version: value.version + 1 }; },
    complete: async () => { calls.complete += 1; if (options.completeError) throw new api.ServerFoundationError("READING_JOB_UNAVAILABLE"); },
    fail: async () => { calls.fail += 1; },
    requeue: async () => { calls.requeue += 1; },
  };
  const audit = [];
  const handler = api.createReadingWorkerHandler("light", { persistence, engineRunner: () => { calls.engine += 1; if (options.engineError) throw new Error("raw secret"); return reading(); }, renderReading: async ({ reading: value }) => { calls.render += 1; return { ...value, rendering: { status: "rendered", provider: "bedrock" } }; }, auditHashSecret: "fixture-only-audit-secret-32-characters-minimum", auditSink: (line) => audit.push(line), clock: { now: () => new Date(NOW) }, orphanGraceSeconds: 60, uuid: () => "lease-owner-fixture" });
  return { handler, calls, audit };
}

test("claim winner alone executes, stages allow-list result, and completes", async () => {
  const { handler, calls, audit } = setup(job());
  assert.deepEqual(await handler({ Records: [message("m1")] }), { batchItemFailures: [] });
  assert.deepEqual(calls, { engine: 1, render: 1, claim: 1, stage: 1, complete: 1, fail: 0, requeue: 0 });
  assert.doesNotMatch(audit.join("\n"), /fixture-user-private|11111111|history-internal|lease-owner|架空|1984/i);
});

test("active duplicate and terminal delivery ack without engine", async () => {
  for (const claim of [{ kind: "active" }, { kind: "terminal" }]) {
    const value = setup(job(), { claim });
    assert.deepEqual(await value.handler({ Records: [message("m2")] }), { batchItemFailures: [] });
    assert.equal(value.calls.engine, 0);
  }
});

test("staged result is finalized after transaction failure without re-render", async () => {
  const value = setup(job({ state: "IN_PROGRESS", stagedResult: { resolved_mode: "light", status: "completed", rendering_status: "rendered", result: { title: "x", sections: [], one_step: "x", avoid_hint: "x" } }, leaseOwner: "owner", leaseExpiresAt: 2_000_000_000 }));
  assert.deepEqual(await value.handler({ Records: [message("m3")] }), { batchItemFailures: [] });
  assert.deepEqual([value.calls.engine, value.calls.render, value.calls.complete], [0, 0, 1]);
});

test("young orphan retries, old orphan and malformed poison ack", async () => {
  const value = setup(undefined);
  const malformed = JSON.stringify({ schema_version: "bad", job_ref: JOB_REF });
  const result = await value.handler({ Records: [message("young", 10_000), message("old", 61_000), message("bad", 1_000, malformed)] });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "young" }] });
  assert.equal(value.calls.engine, 0);
  assert.match(value.audit.join("\n"), /reading_orphan_message_discarded|reading_job_message_discarded/);
});

test("terminal generation failure is persisted and acked; persistence failure retries only that record", async () => {
  const terminal = setup(job(), { engineError: true });
  assert.deepEqual(await terminal.handler({ Records: [message("terminal")] }), { batchItemFailures: [] });
  assert.equal(terminal.calls.fail, 1);
  const retry = setup(job(), { stageError: true });
  assert.deepEqual(await retry.handler({ Records: [message("retry"), message("poison", 1_000, "{}") ] }), { batchItemFailures: [{ itemIdentifier: "retry" }] });
  assert.equal(retry.calls.fail, 0);
  assert.equal(retry.calls.requeue, 1);
});
