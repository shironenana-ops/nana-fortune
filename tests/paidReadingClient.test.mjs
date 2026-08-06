import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transform } from "esbuild";

const source = fs.readFileSync(new URL("../src/lib/paidReadingClient.ts", import.meta.url), "utf8");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);

const base = "https://fixture.execute-api.ap-northeast-1.amazonaws.com/production";
const completed = {
  status: "COMPLETED",
  reading: { result: { title: "Fixture", sections: [{ id: "theme", heading: "Theme", body: "Body" }], one_step: "Step", avoid_hint: "Avoid" } },
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("paid reading sends only canonical input and polls the owner job reference", async () => {
  const calls = [];
  const bodies = [response(202, { request_id: "r", job_ref: "opaque_job_reference_123", status: "queued" }), response(200, { status: "IN_PROGRESS" }), response(200, completed)];
  const result = await api.runPaidReading({
    readingUrl: `${base}/reading`, statusUrl: `${base}/reading/status`, token: "signed-token", idempotencyKey: "a".repeat(32),
    reading: { name: "Fixture", birthDate: "2000-01-01", question: "Question", mode: "light" },
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return bodies.shift(); },
    wait: async () => {}, maxPolls: 3,
  });
  assert.equal(result.title, "Fixture");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.Authorization, "Bearer signed-token");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "a".repeat(32));
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request, { name: "Fixture", birth_date: "2000-01-01", question: "Question", requested_mode: "light" });
  assert.equal("user_id" in request, false);
  assert.match(calls[1].url, /reading\/status\?job_ref=opaque_job_reference_123$/u);
});

test("paid reading accepts the local-staging route without mixing stages", async () => {
  const staging = "https://fixture.execute-api.ap-northeast-1.amazonaws.com/staging";
  const result = await api.runPaidReading({
    readingUrl: `${staging}/reading`, statusUrl: `${staging}/reading/status`, token: "signed-token", idempotencyKey: "b".repeat(32),
    reading: { name: "Fixture", birthDate: "2000-01-01", mode: "deep" },
    fetchImpl: async () => response(200, { status: "completed", result: completed.reading.result }), maxPolls: 1,
  });
  assert.equal(result.title, "Fixture");
});

test("paid reading rejects production/staging URL mixing before network access", async () => {
  let calls = 0;
  await assert.rejects(() => api.runPaidReading({
    readingUrl: `${base}/reading`, statusUrl: "https://fixture.execute-api.ap-northeast-1.amazonaws.com/staging/reading/status",
    token: "signed-token", idempotencyKey: "c".repeat(32), reading: { name: "Fixture", birthDate: "2000-01-01", mode: "light" },
    fetchImpl: async () => { calls += 1; return response(500, {}); },
  }), /READING_CONFIGURATION_ERROR/u);
  assert.equal(calls, 0);
});

test("paid reading exposes only a fixed safe failure code", async () => {
  await assert.rejects(() => api.runPaidReading({
    readingUrl: `${base}/reading`, statusUrl: `${base}/reading/status`, token: "signed-token", idempotencyKey: "d".repeat(32),
    reading: { name: "Fixture", birthDate: "2000-01-01", mode: "light" },
    fetchImpl: async () => response(503, { error: { code: "READING_API_DISABLED", message: "safe" }, internal: "not surfaced" }),
  }), (error) => error instanceof api.PaidReadingClientError && error.code === "READING_API_DISABLED" && !error.message.includes("not surfaced"));
});
