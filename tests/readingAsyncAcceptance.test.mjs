import assert from "node:assert/strict";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";

await buildReadingFoundation();
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?async-acceptance=${Date.now()}`);

const JOB_REF = "11111111-1111-4111-8111-111111111111";
const HISTORY_ID = "22222222-2222-4222-8222-222222222222";
const request = {
  requestId: "request-public-acceptance",
  requestRef: "a".repeat(64),
  fingerprint: "b".repeat(64),
  userId: "fixture-user-private",
  membershipTier: "light",
  mode: "light",
  canonicalInput: {
    name: "架空 花子",
    birthDate: "1984-12-29",
    readingDate: "2026-07-24",
    resolvedMode: "light",
  },
  now: new Date("2026-07-24T00:00:00Z"),
};

test("queue succeeds before the acceptance transaction and only opaque public ids are returned", async () => {
  const order = [];
  let accepted;
  const service = api.createReadingAsyncAcceptance({
    queue: {
      send: async (mode, jobRef) => {
        order.push("queue");
        assert.equal(mode, "light");
        assert.equal(jobRef, JOB_REF);
      },
    },
    persistence: {
      precheck: async () => ({ kind: "missing" }),
      accept: async (value) => {
        order.push("accept");
        accepted = value;
        return "accepted";
      },
    },
    auditHashSecret: "fixture-only-audit-secret-32-characters-minimum",
    uuid: (() => {
      const values = [JOB_REF, HISTORY_ID];
      return () => values.shift();
    })(),
  });

  const response = await service.enqueue(request);
  assert.deepEqual(response, {
    request_id: request.requestId,
    reading_id: HISTORY_ID,
    status: "queued",
  });
  assert.deepEqual(order, ["queue", "accept"]);
  assert.equal(accepted.jobRef, JOB_REF);
  assert.notEqual(accepted.jobRef, accepted.historyId);
  assert.match(accepted.ownerRef, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(response), /fixture-user-private|1984-12-29|架空 花子/u);
});

test("queue failure is fail closed before rate, quota, history, or job persistence", async () => {
  let acceptanceCalls = 0;
  const service = api.createReadingAsyncAcceptance({
    queue: { send: async () => { throw new api.ServerFoundationError("READING_QUEUE_UNAVAILABLE"); } },
    persistence: {
      precheck: async () => ({ kind: "missing" }),
      accept: async () => { acceptanceCalls += 1; return "accepted"; },
    },
    auditHashSecret: "fixture-only-audit-secret-32-characters-minimum",
    uuid: (() => {
      const values = [JOB_REF, HISTORY_ID];
      return () => values.shift();
    })(),
  });

  await assert.rejects(service.enqueue(request), (error) => error.code === "READING_QUEUE_UNAVAILABLE");
  assert.equal(acceptanceCalls, 0);
});

test("exact kill switch accepts only lowercase true", () => {
  assert.equal(api.readingAsyncPaidEnabled("true"), true);
  for (const value of [undefined, "", "TRUE", "True", "1", " true", "true "]) {
    assert.equal(api.readingAsyncPaidEnabled(value), false);
  }
});
