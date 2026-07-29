import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const candidates = process.platform === "win32"
  ? [process.env.PYTHON, "C:\\Users\\kokur\\AppData\\Local\\Python\\bin\\python.exe", "python", "py"].filter(Boolean)
  : [process.env.PYTHON, "python3", "python"].filter(Boolean);

function python() {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("Python 3 is required for the staging CLI harness tests");
}

test("staging CLI harness unit suite passes without AWS access", () => {
  const result = spawnSync(python(), [
    "-m", "unittest",
    "tests/test_reading_staging_cli_harness.py",
    "tests/test_reading_staging_cli_adapter.py",
    "tests/test_session_token_compat.py",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: "true" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("harness and shared signer contain no committed credential or unsafe default execution", () => {
  for (const path of ["scripts/reading_staging_cli_harness.py", "scripts/build_login_lambda.py", "lambda/session_token.py"]) {
    assert.ok(existsSync(path));
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gho_|github_pat_/u);
  }
  const harness = readFileSync("scripts/reading_staging_cli_harness.py", "utf8");
  assert.match(harness, /--execute/u);
  assert.match(harness, /CREATE_STAGING_LIGHT_TEST_ID_AND_RUN_PHASE1_SMOKE/u);
  assert.match(harness, /boto3\.Session/u);
  assert.match(harness, /integrations\/\{self\._resource/u);
  assert.doesNotMatch(harness, /SHIRONE_STAGING_SESSION_TOKEN|subprocess/u);
  assert.doesNotMatch(harness, /delete-item|update-item|batch-write-item|transact-write-items/iu);
  assert.doesNotMatch(harness, /["']scan["']/iu);
});
