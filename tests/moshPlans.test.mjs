import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  MOSH_PLANS,
  canApplyForMoshPlan,
  getSafeMoshUrl,
  isMoshBillingEnabled,
} from "../src/lib/moshPlans.ts";

test("課金フラグは文字列trueの明示指定時だけON", () => {
  for (const value of [undefined, null, "", "false", "TRUE", true, "1"]) {
    assert.equal(isMoshBillingEnabled(value), false);
  }
  assert.equal(isMoshBillingEnabled("true"), true);
});

test("確定済みの商品ID・価格・MOSH URLを取り違えない", () => {
  assert.equal(MOSH_PLANS.light.price, 980);
  assert.equal(MOSH_PLANS.premium.price, 2980);
  assert.equal(MOSH_PLANS.voice_single.price, 300);
  assert.match(getSafeMoshUrl(MOSH_PLANS.light), /services\/385958/);
  assert.match(getSafeMoshUrl(MOSH_PLANS.premium), /services\/385965/);
  assert.match(getSafeMoshUrl(MOSH_PLANS.voice_single), /services\/385969/);
  assert.equal(getSafeMoshUrl(MOSH_PLANS.free), null);
});

test("OFF時・URL不足時・不正URLでは申込み不可", () => {
  assert.equal(canApplyForMoshPlan(MOSH_PLANS.light, false), false);
  assert.equal(canApplyForMoshPlan({ ...MOSH_PLANS.light, moshUrl: null }, true), false);
  for (const moshUrl of ["javascript:alert(1)", "http://mosh.jp/services/385958", "https://example.com/services/385958"] ) {
    assert.equal(getSafeMoshUrl({ ...MOSH_PLANS.light, moshUrl }), null);
  }
});

test("joinはMOSH導線だけを使用し、旧Checkoutやカード情報を扱わない", () => {
  const joinSource = readFileSync(new URL("../src/pages/join.astro", import.meta.url), "utf8");
  const legacySource = readFileSync(new URL("../public/js/billing.js", import.meta.url), "utf8");

  assert.match(joinSource, /target="_blank"/);
  assert.match(joinSource, /rel="noopener noreferrer"/);
  assert.match(joinSource, /カード番号を取得・保存しません/);
  assert.doesNotMatch(joinSource, /billing\.js|data-checkout-plan|fincode.*API/i);
  assert.doesNotMatch(legacySource, /fetch\s*\(|execute-api|stripe/i);
});
