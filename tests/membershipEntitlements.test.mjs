import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transform } from "esbuild";

async function compileModule(sourcePath, replacements = {}) {
  const source = fs.readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  let code = compiled.code;
  for (const [specifier, replacement] of Object.entries(replacements)) {
    code = code.replaceAll(specifier, replacement);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const accessPolicyUrl = await compileModule("../src/lib/accessPolicy.ts");
const membershipUrl = await compileModule("../src/lib/membership.ts", {
  "./accessPolicy": accessPolicyUrl,
});
const entitlementsUrl = await compileModule("../src/lib/membershipEntitlements.ts", {
  "./membership": membershipUrl,
  "./accessPolicy": accessPolicyUrl,
});
const { getMembershipEntitlements } = await import(entitlementsUrl);

const premiumActive = {
  plan: "premium",
  subscription_status: "active",
  deep_enabled: true,
  monthly_voice_limit: 20,
  monthly_voice_used: 4,
  extra_voice_remaining: 0,
};

test("premiumかつactiveかつdeep_enabledの場合だけ深掘り可能", () => {
  assert.equal(getMembershipEntitlements(premiumActive).canUseDeep, true);
  assert.equal(getMembershipEntitlements({ ...premiumActive, subscription_status: "inactive" }).canUseDeep, false);
  assert.equal(getMembershipEntitlements({ ...premiumActive, deep_enabled: false }).canUseDeep, false);
  assert.equal(getMembershipEntitlements({ ...premiumActive, plan: "light" }).canUseDeep, false);
  assert.equal(getMembershipEntitlements({ ...premiumActive, plan: "free" }).canUseDeep, false);
});

test("premiumの有効契約だけが月間音声枠を利用できる", () => {
  const available = getMembershipEntitlements(premiumActive);
  assert.equal(available.monthlyVoiceRemaining, 16);
  assert.equal(available.canUseMonthlyVoice, true);
  assert.equal(getMembershipEntitlements({ ...premiumActive, monthly_voice_used: 20 }).canUseMonthlyVoice, false);
  assert.equal(getMembershipEntitlements({ ...premiumActive, subscription_status: "inactive" }).canUseMonthlyVoice, false);
});

test("freeとlightも単発残数があれば音声利用権を持つ", () => {
  for (const plan of ["free", "light", "normal"]) {
    const result = getMembershipEntitlements({ plan, extra_voice_remaining: 2 });
    assert.equal(result.canUseExtraVoice, true);
    assert.equal(result.canUseVoice, true);
  }
  assert.equal(getMembershipEntitlements({ plan: "free", extra_voice_remaining: 0 }).canUseExtraVoice, false);
});

test("月間枠と単発枠を混同せず、全体の音声利用権を返す", () => {
  const result = getMembershipEntitlements({ ...premiumActive, extra_voice_remaining: 3 });
  assert.equal(result.monthlyVoiceRemaining, 16);
  assert.equal(result.extraVoiceRemaining, 3);
  assert.equal(result.canUseMonthlyVoice, true);
  assert.equal(result.canUseExtraVoice, true);
  assert.equal(result.canUseVoice, true);
});

test("利用数超過や負数を0へ丸める", () => {
  const result = getMembershipEntitlements({
    ...premiumActive,
    monthly_voice_limit: 5,
    monthly_voice_used: 8,
    extra_voice_remaining: -4,
  });
  assert.equal(result.monthlyVoiceRemaining, 0);
  assert.equal(result.extraVoiceRemaining, 0);
  assert.equal(result.canUseVoice, false);
});

test("旧Stripe属性だけでは権限を付与しない", () => {
  const result = getMembershipEntitlements({
    stripe_customer_id: "legacy",
    stripe_subscription_status: "active",
  });
  assert.equal(result.tier, "free");
  assert.equal(result.canUseDeep, false);
  assert.equal(result.canUseVoice, false);
});

test("会員ページは内部識別子と旧Stripeメールを表示しない", () => {
  const source = fs.readFileSync(new URL("../src/pages/members.astro", import.meta.url), "utf8");
  assert.doesNotMatch(source, /stripe_customer_email|id="stripeMail"/);
  assert.doesNotMatch(source, /memberGreeting.*userId|userId.*さんの会員ページ/);
});
