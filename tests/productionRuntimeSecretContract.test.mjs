import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/prepare_production_runtime_secret.py", import.meta.url), "utf8");

test("production runtime secret recovery is merge-only and uses deployed session consumers", () => {
  for (const name of ["shirone7-login", "shirone7-history-save", "shirone7-history-list", "shirone7-history-detail", "shirone7-voice-upload"]) {
    assert.equal(source.includes(name), true);
  }
  assert.match(source, /merged = dict\(current\)/u);
  assert.doesNotMatch(source, /delete_secret|remove\(|del merged/u);
});

test("production runtime secret recovery never prints secret values or provider errors", () => {
  assert.doesNotMatch(source, /print\(|traceback|sys\.stdout\.write\(.*secret_string/u);
  assert.match(source, /str\(error\) in SAFE_CODES/u);
  assert.match(source, /canonical_keys_present/u);
  assert.match(source, /safe_code/u);
});

test("production runtime secret recovery is preflight-only without explicit apply", () => {
  assert.match(source, /if not args\.apply:/u);
  assert.match(source, /"aws_mutations": 0/u);
  assert.match(source, /parser\.add_argument\("--apply", action="store_true"\)/u);
});
