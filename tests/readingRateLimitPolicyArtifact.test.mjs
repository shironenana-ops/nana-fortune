import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const approvedUrl = new URL("../docs/READING_RATE_LIMIT_POLICY_APPROVED_2026-07-23.json", import.meta.url);
const proposalUrl = new URL("../docs/READING_RATE_LIMIT_POLICY_PROPOSAL_2026-07-23.json", import.meta.url);
const runtimeUrl = new URL("../src/server/readingRateLimit/rateLimitPolicy.ts", import.meta.url);

const expectedPolicies = {
  "free/free": { max_attempts: 10, window_seconds: 600 },
  "light/free": { max_attempts: 10, window_seconds: 600 },
  "light/light": { max_attempts: 3, window_seconds: 900 },
  "premium/free": { max_attempts: 10, window_seconds: 600 },
  "premium/light": { max_attempts: 5, window_seconds: 900 },
  "premium/deep": { max_attempts: 2, window_seconds: 1800 },
};

test("承認済み限定βRate Limit artifactは正確な値と未適用状態を保持する", async () => {
  const raw = await readFile(approvedUrl, "utf8");
  const artifact = JSON.parse(raw);
  assert.equal(artifact.schema_version, "shirone-reading-rate-limit-policy-approved-v1");
  assert.equal(artifact.status, "APPROVED_FOR_LIMITED_BETA_CONFIGURATION");
  assert.equal(artifact.effective_in_production, false);
  assert.deepEqual(artifact.policies, expectedPolicies);
  assert.deepEqual(Object.keys(artifact.policies), Object.keys(expectedPolicies));
  assert.deepEqual(artifact.concurrency, { light: 1, deep: 1 });
  assert.equal(artifact.processing_scope, "JAPAN");
  assert.equal(artifact.global_profile_used, false);
  assert.equal(artifact.fixed_burst_multiplier, 2);
  assert.equal(artifact.requires_staging_revalidation, true);
  assert.doesNotMatch(raw, /secret|token|password|authorization|email|user[_-]?id|question|prompt|account[_-]?id|arn:/iu);
});

test("Phase A proposalは変更されずruntimeは承認artifactを自動読込しない", async () => {
  const proposal = JSON.parse(await readFile(proposalUrl, "utf8"));
  const canonicalHash = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  assert.equal(canonicalHash, "f884d2c39362bd59775aec21861b0f4087fc5e615f65cbfa83d1228e57c94aff");
  assert.equal(proposal.status, "PENDING_HUMAN_APPROVAL");
  assert.equal(proposal.effective_in_production, false);
  const runtime = await readFile(runtimeUrl, "utf8");
  assert.doesNotMatch(runtime, /READING_RATE_LIMIT_POLICY_APPROVED|APPROVED_FOR_LIMITED_BETA_CONFIGURATION/u);
});
