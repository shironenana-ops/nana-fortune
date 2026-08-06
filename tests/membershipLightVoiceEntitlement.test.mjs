import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transform } from "esbuild";

async function compileModule(sourcePath, replacements = {}) {
  const source = fs.readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  let code = compiled.code;
  for (const [specifier, replacement] of Object.entries(replacements)) code = code.replaceAll(specifier, replacement);
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const accessPolicyUrl = await compileModule("../src/lib/accessPolicy.ts");
const membershipUrl = await compileModule("../src/lib/membership.ts", { "./accessPolicy": accessPolicyUrl });
const entitlementsUrl = await compileModule("../src/lib/membershipEntitlements.ts", {
  "./membership": membershipUrl,
  "./accessPolicy": accessPolicyUrl,
});
const { getMembershipEntitlements } = await import(entitlementsUrl);

test("active Light receives its configured monthly voice entitlement", () => {
  const result = getMembershipEntitlements({
    plan: "light",
    subscription_status: "active",
    deep_enabled: false,
    monthly_voice_limit: 3,
    monthly_voice_used: 1,
    extra_voice_remaining: 0,
  });
  assert.equal(result.monthlyVoiceRemaining, 2);
  assert.equal(result.canUseMonthlyVoice, true);
  assert.equal(result.canUseVoice, true);
  assert.equal(result.canUseDeep, false);
});
