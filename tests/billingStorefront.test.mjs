import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BILLING_PLANS,
  getBillingPlan,
  getCheckoutHref,
  getPaidBillingPlan,
  isFincodeCheckoutEnabled,
} from "../src/lib/billingPlans.ts";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const publicBillingFiles = [
  "src/pages/index.astro",
  "src/pages/join.astro",
  "src/pages/checkout.astro",
  "src/pages/premium.astro",
  "src/pages/premium/light.astro",
  "src/pages/premium/deep.astro",
  "src/pages/premium/voice.astro",
  "src/pages/members.astro",
  "src/pages/history/index.astro",
  "src/pages/terms.astro",
  "src/pages/privacy.astro",
  "src/pages/commercial-transactions.astro",
  "src/pages/contact.astro",
  "public/js/billing.js",
];

test("商品Catalogは確定済みの価格・利用枠・請求区分を単一正本として保持する", () => {
  assert.deepEqual(
    Object.keys(BILLING_PLANS),
    ["free", "light", "premium", "voice_single"],
  );

  assert.deepEqual(
    Object.fromEntries(Object.entries(BILLING_PLANS).map(([id, plan]) => [id, {
      price: plan.price,
      billingType: plan.billingType,
      light: plan.lightMonthlyLimit,
      deep: plan.deepMonthlyLimit,
      voice: plan.voiceMonthlyLimit,
      voiceSingle: plan.voiceSingleUnits,
      provider: plan.provider,
    }])),
    {
      free: { price: 0, billingType: "free", light: 0, deep: 0, voice: 0, voiceSingle: 0, provider: null },
      light: { price: 980, billingType: "subscription", light: 5, deep: 0, voice: 3, voiceSingle: 0, provider: "fincode" },
      premium: { price: 2980, billingType: "subscription", light: 20, deep: 3, voice: 10, voiceSingle: 0, provider: "fincode" },
      voice_single: { price: 300, billingType: "one_time", light: 0, deep: 0, voice: 0, voiceSingle: 1, provider: "fincode" },
    },
  );

  const serialized = JSON.stringify(BILLING_PLANS);
  assert.doesNotMatch(serialized, /https?:\/\/|shop.?id|secret|api.?key/i);
});

test("申込対象は固定allow-listだけを受け付け、queryの価格や未知商品を無視する", () => {
  assert.equal(getBillingPlan("free"), BILLING_PLANS.free);
  assert.equal(getPaidBillingPlan("light"), BILLING_PLANS.light);
  assert.equal(getPaidBillingPlan("premium"), BILLING_PLANS.premium);
  assert.equal(getPaidBillingPlan("voice_single"), BILLING_PLANS.voice_single);

  for (const value of [null, undefined, "", "free", "unknown", "light&price=1", { plan: "light" }]) {
    assert.equal(getPaidBillingPlan(value), null);
  }

  assert.equal(getCheckoutHref("light"), "/checkout?plan=light");
  assert.equal(getCheckoutHref("premium"), "/checkout?plan=premium");
  assert.equal(getCheckoutHref("voice_single"), "/checkout?plan=voice_single");
});

test("fincode checkout flagは文字列trueの明示指定時だけON", () => {
  for (const value of [undefined, null, "", "false", "TRUE", true, 1]) {
    assert.equal(isFincodeCheckoutEnabled(value), false);
  }
  assert.equal(isFincodeCheckoutEnabled("true"), true);
});

test("料金ページは4商品と確認画面への導線をCatalogから描画する", () => {
  const join = source("src/pages/join.astro");
  assert.match(join, /BILLING_PLANS/);
  assert.match(join, /getCheckoutHref/);
  assert.match(join, /fincode byGMO/);
  assert.match(join, /本番カード決済はまだ開始していません/);
  assert.match(join, /申込内容を確認する/);
  assert.doesNotMatch(join, /target="_blank"|data-checkout-plan/i);
});

test("checkoutは申込条件を表示し、決済・カード入力・外部通信を開通しない", () => {
  const checkout = source("src/pages/checkout.astro");
  for (const wording of [
    "商品名", "価格", "数量", "請求区分", "利用枠・提供内容",
    "商品代金以外の必要料金", "支払方法", "支払時期", "サービス提供時期",
    "解約方法", "返金・キャンセル", "利用規約", "特定商取引法に基づく表記",
    "プライバシーポリシー", "カード決済へ進む",
  ]) {
    assert.match(checkout, new RegExp(wording));
  }
  assert.match(checkout, /PUBLIC_FINCODE_CHECKOUT_ENABLED/);
  assert.match(checkout, /type="button" disabled aria-disabled="true"/);
  assert.doesNotMatch(checkout, /fetch\s*\(|XMLHttpRequest|<input[^>]+(?:card|number|expiry|cvc)|fincode[^\n]+https?:\/\//i);
  assert.doesNotMatch(checkout, /Astro\.url\.searchParams\.get\(["'](?:price|quantity|amount)["']\)/i);
});

test("公開ページはdirect fincode表記へ統一し、旧導線と旧準備中文言を残さない", () => {
  const combined = publicBillingFiles.map(source).join("\n");
  assert.doesNotMatch(combined, /MOSH|mosh\.jp|PUBLIC_MOSH_BILLING_ENABLED/i);
  assert.doesNotMatch(combined, /料金は準備中|料金が発生することはありません|自動反映ではありません/u);
  assert.match(combined, /fincode byGMO/u);
  assert.match(combined, /shirone\.nana\.fortune@gmail\.com/u);
});

test("法務3文書は決済・提供時期・解約・返金・履歴の扱いで整合する", () => {
  const terms = source("src/pages/terms.astro");
  const privacy = source("src/pages/privacy.astro");
  const commerce = source("src/pages/commercial-transactions.astro");

  for (const document of [terms, privacy, commerce]) {
    assert.match(document, /fincode byGMO/u);
    assert.match(document, /取得(?:・|または)保存|取得または保存|取得・保持/u);
  }

  assert.match(terms, /契約期間末まで利用/u);
  assert.match(terms, /日割り返金は行いません/u);
  assert.match(terms, /本人の履歴として保持/u);
  assert.match(commerce, /24時間以内/u);
  assert.match(commerce, /重複請求/u);
  assert.match(privacy, /決済結果、契約状態/u);
});
