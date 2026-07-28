import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { buildReadingFoundation } from "../scripts/build-reading-foundation.mjs";
import { buildReadingStatusHandler } from "../scripts/build-reading-status-handler.mjs";

const [foundationBuild, statusBuild] = await Promise.all([buildReadingFoundation(), buildReadingStatusHandler()]);
const api = await import(`${new URL("../dist/reading-server-foundation/index.mjs", import.meta.url).href}?status=${Date.now()}`);

const SECRET = "fixture-only-session-secret-32-characters-minimum";
const AUDIT_SECRET = "fixture-only-audit-secret-32-characters-minimum";
const USER = "fixture-owner-private";
const OTHER_USER = "fixture-other-private";
const JOB = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-27T00:00:00Z");
const ORIGIN = "https://fixture.example";

function token(userId = USER, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, iat: 1_700_000_000, exp: 2_000_000_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function event(overrides = {}) {
  return {
    version: "2.0",
    routeKey: "GET /reading/status",
    rawPath: "/reading/status",
    rawQueryString: `job_ref=${JOB}`,
    queryStringParameters: { job_ref: JOB },
    headers: { origin: ORIGIN, authorization: `Bearer ${token()}` },
    requestContext: { requestId: "status-request-001", http: { method: "GET" } },
    ...overrides,
  };
}

function reading() {
  return {
    resolved_mode: "light",
    status: "completed",
    rendering_status: "rendered",
    result: { title: "架空の鑑定", sections: [{ id: "overview", heading: "全体", body: "架空の本文" }], one_step: "一歩", avoid_hint: "注意" },
  };
}

function setup(record) {
  const calls = { read: 0, quota: 0, rate: 0, concurrency: 0, bedrock: 0, enqueue: 0 };
  const audit = [];
  const repository = {
    readOwned: async (params) => {
      calls.read += 1;
      calls.params = params;
      return typeof record === "function" ? record(params) : record;
    },
  };
  const handler = api.createReadingStatusHandler({ enabled: true, allowedOrigins: new Set([ORIGIN]) }, {
    repository, sessionSecret: SECRET, auditHashSecret: AUDIT_SECRET, auditSink: (line) => audit.push(line), now: () => NOW,
  });
  return { handler, calls, audit };
}

function body(response) { return JSON.parse(response.body); }

test("owner can read the four minimal public states and only completed includes history result", async () => {
  for (const state of ["QUEUED", "IN_PROGRESS", "FAILED", "COMPLETED"]) {
    const record = state === "COMPLETED" ? { state, reading: reading() } : { state };
    const { handler, calls } = setup(record);
    const response = await handler(event());
    const value = body(response);
    assert.equal(response.statusCode, 200);
    assert.equal(value.status, state);
    assert.equal(value.job_ref, JOB);
    assert.equal("reading" in value, state === "COMPLETED");
    assert.equal(response.headers["Retry-After"], ["QUEUED", "IN_PROGRESS"].includes(state) ? "3" : undefined);
    if (state === "FAILED") assert.deepEqual(Object.keys(value.error).sort(), ["code", "message"]);
    assert.equal(calls.read, 1);
  }
});

test("status is read-only and does not consume quota, rate, concurrency, Bedrock, or queue", async () => {
  const { handler, calls } = setup({ state: "QUEUED" });
  assert.equal((await handler(event())).statusCode, 200);
  assert.deepEqual({ quota: calls.quota, rate: calls.rate, concurrency: calls.concurrency, bedrock: calls.bedrock, enqueue: calls.enqueue }, { quota: 0, rate: 0, concurrency: 0, bedrock: 0, enqueue: 0 });
  assert.equal(calls.params.userId, USER);
  assert.match(calls.params.ownerRef, /^[0-9a-f]{64}$/u);
});

test("other owner and missing job have the identical non-enumerating response", async () => {
  const missing = setup(undefined);
  const other = setup((params) => params.userId === OTHER_USER ? undefined : { state: "QUEUED" });
  const missingResponse = await missing.handler(event());
  const otherResponse = await other.handler(event({ headers: { origin: ORIGIN, authorization: `Bearer ${token(OTHER_USER)}` } }));
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(otherResponse.statusCode, 404);
  assert.equal(body(missingResponse).error.code, "READING_STATUS_NOT_FOUND");
  assert.equal(body(otherResponse).error.code, "READING_STATUS_NOT_FOUND");
  assert.equal(body(missingResponse).error.message, body(otherResponse).error.message);
});

test("invalid job_ref, missing token, and invalid token fail before or at authentication", async () => {
  const invalid = setup({ state: "QUEUED" });
  const invalidResponse = await invalid.handler(event({ rawQueryString: "job_ref=sequential-1", queryStringParameters: { job_ref: "sequential-1" } }));
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(body(invalidResponse).error.code, "READING_STATUS_REF_INVALID");
  assert.equal(invalid.calls.read, 0);

  for (const authorization of [undefined, "Bearer invalid.token"]) {
    const current = setup({ state: "QUEUED" });
    const headers = { origin: ORIGIN };
    if (authorization) headers.authorization = authorization;
    const response = await current.handler(event({ headers }));
    assert.equal(response.statusCode, 401);
    assert.equal(current.calls.read, 0);
  }
});

test("query shape, method, CORS preflight, body, and exact kill switch fail closed", async () => {
  const { handler, calls } = setup({ state: "QUEUED" });
  assert.equal((await handler(event({ rawQueryString: `job_ref=${JOB}&extra=1`, queryStringParameters: { job_ref: JOB, extra: "1" } }))).statusCode, 400);
  assert.equal((await handler(event({ body: "{}" }))).statusCode, 400);
  const method = await handler(event({ requestContext: { requestId: "method", http: { method: "POST" } } }));
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.Allow, "GET, OPTIONS");
  const preflight = await handler(event({ routeKey: "OPTIONS /reading/status", rawQueryString: "", queryStringParameters: undefined, headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "Authorization" }, requestContext: { requestId: "options", http: { method: "OPTIONS" } } }));
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Methods"], "GET,OPTIONS");
  assert.equal(calls.read, 0);
  assert.equal(api.readingStatusApiEnabled("true"), true);
  for (const value of [undefined, "", "TRUE", "1", " true "]) assert.equal(api.readingStatusApiEnabled(value), false);
});

test("status routeKeyを正としnamed stage付きrawPathには依存しない", async () => {
  const { handler, calls } = setup({ state: "QUEUED" });
  for (const rawPath of ["/reading/status", "/staging/reading/status"]) {
    const response = await handler(event({ routeKey: "GET /reading/status", rawPath }));
    assert.equal(response.statusCode, 200);
    assert.equal(body(response).status, "QUEUED");
  }
  assert.equal(calls.read, 2);
});

test("statusの不正・欠落・型不正routeKeyをrawPathが正しくてもfail closedで拒否する", async () => {
  const { handler, calls } = setup({ state: "QUEUED" });
  for (const routeKey of ["GET /other", "POST /reading/status", undefined, null, 42, { route: "GET /reading/status" }]) {
    const response = await handler(event({ routeKey, rawPath: "/reading/status" }));
    assert.equal(response.statusCode, 404);
    assert.equal(body(response).error.code, "HTTP_ROUTE_NOT_FOUND");
  }
  assert.equal(calls.read, 0);
});

test("status routeKeyとrequestContext methodの不一致を受理しない", async () => {
  const { handler, calls } = setup({ state: "QUEUED" });
  const response = await handler(event({
    routeKey: "GET /reading/status",
    requestContext: { requestId: "status-route-method-mismatch-001", http: { method: "OPTIONS" } },
  }));
  assert.equal(response.statusCode, 404);
  assert.equal(body(response).error.code, "HTTP_ROUTE_NOT_FOUND");
  assert.equal(calls.read, 0);
});

test("disabled or incomplete production configuration fails closed without repository access", async () => {
  let reads = 0;
  const disabled = api.createReadingStatusHandler({ enabled: false, allowedOrigins: new Set([ORIGIN]) }, {
    repository: { readOwned: async () => { reads += 1; return { state: "QUEUED" }; } },
    sessionSecret: SECRET,
    auditHashSecret: AUDIT_SECRET,
  });
  const response = await disabled(event());
  assert.equal(response.statusCode, 503);
  assert.equal(body(response).error.code, "READING_STATUS_API_DISABLED");
  assert.equal(reads, 0);
  assert.deepEqual(api.readReadingStatusConfig({ READING_JOBS_TABLE_NAME: "jobs", READING_HISTORY_TABLE_NAME: "history" }), { jobsTable: "jobs", historyTable: "history" });
  for (const config of [{}, { READING_JOBS_TABLE_NAME: "jobs" }, { READING_JOBS_TABLE_NAME: "jobs\nother", READING_HISTORY_TABLE_NAME: "history" }]) {
    assert.throws(() => api.readReadingStatusConfig(config), (error) => error.code === "READING_STATUS_UNAVAILABLE");
  }
});

test("responses and audit never expose raw owner, internals, provider errors, or stack", async () => {
  const leaked = setup(async () => { throw new api.ServerFoundationError("READING_STATUS_UNAVAILABLE", { cause: new Error("AWS request-id stack raw prompt PII") }); });
  const response = await leaked.handler(event());
  assert.equal(response.statusCode, 503);
  const output = `${response.body}\n${leaked.audit.join("\n")}`;
  assert.doesNotMatch(output, /fixture-owner-private|fixture-other-private|AWS|request-id|stack|raw prompt|PII|history_id|owner_ref|user_id/u);
  assert.doesNotMatch(output, new RegExp(JOB, "u"));
});

test("Dynamo repository strongly reads owned job and uses history as completed source of truth", async () => {
  const ownerRef = api.createReadingJobOwnerRef(USER, AUDIT_SECRET);
  const commands = [];
  const sender = { send: async (command) => {
    commands.push(command);
    if (command.input.TableName === "jobs") return { Item: { schema_version: { S: "shirone-reading-job-v1" }, owner_ref: { S: ownerRef }, state: { S: "COMPLETED" }, history_id: { S: "history-private" }, mode: { S: "light" }, staged_public_result: { S: "must-not-be-read" } } };
    return { Item: { schema_version: { S: "shirone-reading-history-v1" }, status: { S: "completed" }, resolved_mode: { S: "light" }, public_result: { S: JSON.stringify(reading()) } } };
  } };
  const repository = new api.DynamoReadingStatusRepository(sender, { jobsTable: "jobs", historyTable: "history" });
  const result = await repository.readOwned({ jobRef: JOB, userId: USER, ownerRef });
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.reading.result.title, "架空の鑑定");
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.constructor.name === "GetItemCommand" && command.input.ConsistentRead === true));
  assert.doesNotMatch(commands[0].input.ProjectionExpression, /staged_public_result|owner_user_id|canonical_input/u);
  assert.deepEqual(commands[1].input.Key, { user_id: { S: USER }, history_id: { S: "history-private" } });
});

test("Dynamo ownership mismatch is indistinguishable and does not read history", async () => {
  let sends = 0;
  const repository = new api.DynamoReadingStatusRepository({ send: async () => { sends += 1; return { Item: { owner_ref: { S: "f".repeat(64) } } }; } }, { jobsTable: "jobs", historyTable: "history" });
  assert.equal(await repository.readOwned({ jobRef: JOB, userId: USER, ownerRef: api.createReadingJobOwnerRef(USER, AUDIT_SECRET) }), undefined);
  assert.equal(sends, 1);
});

test("status Lambda artifact is Node 22 ESM and contains no mutating/provider/queue dependency", async () => {
  const artifactPath = "dist/reading-status-handler/index.mjs";
  const artifact = fs.readFileSync(artifactPath, "utf8");
  assert.ok(fs.statSync(artifactPath).size > 0);
  assert.ok(Object.keys(statusBuild.metafile.inputs).some((name) => name.includes("readingStatusLambda.ts")));
  assert.ok(Object.keys(foundationBuild.metafile.inputs).some((name) => name.includes("readingStatusService.ts")));
  assert.doesNotMatch(artifact, /SQS|Bedrock|ConverseCommand|SendMessageCommand|UpdateItemCommand|PutItemCommand|TransactWriteItemsCommand|READING_DEEP_GENERATE_API_ENABLED/u);
  assert.doesNotMatch(artifact, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_|fixture-owner-private/u);
  const module = await import(`${new URL(`../${artifactPath}`, import.meta.url).href}?artifact=${Date.now()}`);
  assert.equal(typeof module.handler, "function");
});
