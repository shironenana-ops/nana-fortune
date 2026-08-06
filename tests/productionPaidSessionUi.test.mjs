import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const paidForm = fs.readFileSync(new URL("../src/components/PaidReadingForm.astro", import.meta.url), "utf8");
const members = fs.readFileSync(new URL("../src/pages/members.astro", import.meta.url), "utf8");

test("paid reading reuses the canonical login token key", () => {
  assert.match(paidForm, /localStorage\.getItem\("token"\)/u);
  assert.doesNotMatch(paidForm, /session_token/u);
});

test("members page renders canonical Light and Deep quota balances", () => {
  assert.match(members, /id="lightQuota"/u);
  assert.match(members, /setText\("lightQuota", `\$\{lightRemaining\} \/ \$\{lightLimit\}`\)/u);
  assert.match(members, /`\$\{deepRemaining\} \/ \$\{deepLimit\}`/u);
});
