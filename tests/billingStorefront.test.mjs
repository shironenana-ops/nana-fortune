import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BILLING_PLANS,
  FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
  PUBLIC_SALE_BILLING_PLAN_IDS,
  getBillingPlan,
  getCheckoutHref,
  getPaidBillingPlan,
  getPublicCheckoutHref,
  isFincodeCheckoutEnabled,
  isFincodeTestCheckoutEnabled,
  isFincodeTestLightCheckoutEnabled,
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

  assert.deepEqual(PUBLIC_SALE_BILLING_PLAN_IDS, ["light", "premium", "voice_single"]);
  assert.equal(getPublicCheckoutHref("light"), "/checkout?plan=light");
  assert.equal(getPublicCheckoutHref("premium"), "/checkout?plan=premium");
  assert.equal(getPublicCheckoutHref("voice_single"), "/checkout?plan=voice_single");
  assert.equal(getPublicCheckoutHref("unknown"), null);
  assert.deepEqual(BILLING_PLANS.light.features, [
    "無料機能",
    "ライト鑑定 月5回",
    "音声鑑定 月3回",
    "鑑定履歴の保存・閲覧",
  ]);
  assert.deepEqual(BILLING_PLANS.premium.features, [
    "無料機能",
    "ライト鑑定 月20回",
    "深掘り鑑定 月3回",
    "音声鑑定 月10回",
    "鑑定履歴の保存・閲覧",
  ]);
  assert.deepEqual(BILLING_PLANS.voice_single.features, [
    "音声鑑定1回分",
    "月額契約なし",
    "買い切り",
  ]);
});

test("fincode checkout flagは文字列trueの明示指定時だけON", () => {
  for (const value of [undefined, null, "", "false", "TRUE", true, 1]) {
    assert.equal(isFincodeCheckoutEnabled(value), false);
  }
  assert.equal(isFincodeCheckoutEnabled("true"), true);
});

test("fincode TEST checkoutはvoice_singleとTEST公開鍵の組合せだけを許可する", () => {
  assert.equal(isFincodeTestCheckoutEnabled({ enabled: "true", planId: "voice_single", publicKey: "p_test_FAKE" }), true);
  for (const input of [
    { enabled: undefined, planId: "voice_single", publicKey: "p_test_FAKE" },
    { enabled: "false", planId: "voice_single", publicKey: "p_test_FAKE" },
    { enabled: "true", planId: "light", publicKey: "p_test_FAKE" },
    { enabled: "true", planId: "premium", publicKey: "p_test_FAKE" },
    { enabled: "true", planId: "voice_single", publicKey: "p_live_FORBIDDEN" },
    { enabled: "true", planId: "voice_single", publicKey: "p_test_" },
  ]) {
    assert.equal(isFincodeTestCheckoutEnabled(input), false);
  }
});

test("Light TEST checkoutはlocal-stagingとBrowser E2E profileの完全一致だけを許可する", () => {
  const valid = {
    enabled: "true",
    runtimeEnvironment: "local-staging",
    publicProfile: FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
    serverProfile: FINCODE_TEST_LIGHT_BROWSER_E2E_PROFILE,
    planId: "light",
    publicKey: "p_test_FAKE",
  };
  assert.equal(isFincodeTestLightCheckoutEnabled(valid), true);
  for (const override of [
    { enabled: "false" },
    { runtimeEnvironment: "production" },
    { publicProfile: "" },
    { serverProfile: "" },
    { planId: "voice_single" },
    { planId: "premium" },
    { publicKey: "p_prod_FORBIDDEN" },
  ]) {
    assert.equal(isFincodeTestLightCheckoutEnabled({ ...valid, ...override }), false);
  }
});

test("料金ページは3商品すべての申込内容確認導線を公開する", () => {
  const join = source("src/pages/join.astro");
  assert.match(join, /BILLING_PLANS/);
  assert.match(join, /getPublicCheckoutHref/);
  assert.match(join, /fincode byGMO/);
  assert.match(join, /カード決済受付だけがfincode本番環境の審査待ち/u);
  assert.match(join, /申込内容を確認する/);
  assert.match(join, /getPublicCheckoutHref/u);
  assert.doesNotMatch(join, /今後提供予定|機能準備中|現在申込不可/u);
  assert.doesNotMatch(join, /target="_blank"|data-checkout-plan/i);
});

test("checkoutは通常時の決済停止を維持し、Light Browser E2Eとvoice_single TEST経路を分離する", () => {
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
  assert.doesNotMatch(checkout, /futureOnlyPlan|今後提供予定|機能準備中|現在申込不可/u);
  assert.match(checkout, /買い切り商品のため、自動更新と解約手続きはありません/u);
  assert.match(checkout, /selectedPlan\.billingType === "subscription"/u);
  assert.match(checkout, /PUBLIC_FINCODE_TEST_PAYMENT_ENABLED/);
  assert.match(checkout, /isFincodeTestCheckoutEnabled/);
  assert.match(checkout, /fetch\("\/api\/billing\/fincode\/test\/register"/);
  assert.equal((checkout.match(/fetch\("\/api\/billing\/fincode\/test\/register"/gu) ?? []).length >= 3, true);
  assert.doesNotMatch(checkout, /\/api\/billing\/fincode\/test\/light\/register/u);
  assert.match(checkout, /prepared\.product !== "light"/);
  assert.match(checkout, /prepared\.amount !== 980/);
  assert.match(checkout, /subscribed\.product !== "light"/);
  assert.match(checkout, /voice_singleへ切り替えず停止/u);
  assert.match(checkout, /initFincode/);
  assert.doesNotMatch(checkout, /XMLHttpRequest|<input[^>]+(?:card|number|expiry|cvc)|https:\/\/api\.fincode\.jp/i);
  assert.doesNotMatch(checkout, /Astro\.url\.searchParams\.get\(["'](?:price|quantity|amount)["']\)/i);
});

test("公開ページはdirect fincode表記へ統一し、旧導線と旧準備中文言を残さない", () => {
  const combined = publicBillingFiles.map(source).join("\n");
  assert.doesNotMatch(combined, /MOSH|mosh\.jp|PUBLIC_MOSH_BILLING_ENABLED/i);
  assert.doesNotMatch(combined, /料金は準備中|料金が発生することはありません|自動反映ではありません/u);
  assert.doesNotMatch(combined, /今後提供予定|機能準備中|現在申込不可|決済準備中|Stripe/u);
  assert.match(combined, /fincode byGMO/u);
  assert.match(combined, /shirone\.nana\.fortune@gmail\.com/u);
});

test("LightとPremiumの鑑定機能は提供準備済みで、停止対象を本番カード申込受付に限定する", () => {
  for (const path of ["src/pages/premium/light.astro", "src/pages/premium/deep.astro"]) {
    const page = source(path);
    assert.match(page, /提供準備済み/u);
    assert.match(page, /fincode本番審査中/u);
    assert.match(page, /カード決済によるお申し込み受付を停止しています/u);
    assert.match(page, /審査完了後に受付を開始します/u);
    assert.doesNotMatch(page, /鑑定として準備しています|機能準備中|今後提供予定|有料機能は準備中|料金は発生しません/u);
  }
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

test("公開販売契約はLight・Premium・音声鑑定1回分へ統一される", () => {
  const index = source("src/pages/index.astro");
  const join = source("src/pages/join.astro");
  const checkout = source("src/pages/checkout.astro");
  const terms = source("src/pages/terms.astro");
  const commerce = source("src/pages/commercial-transactions.astro");
  const contact = source("src/pages/contact.astro");
  const members = source("src/pages/members.astro");

  for (const document of [index, join, terms, commerce, contact, members]) {
    assert.match(document, /ライト会員/u);
    assert.match(document, /プレミアム会員/u);
    assert.match(document, /音声鑑定1回分/u);
  }
  assert.match(checkout, /getPaidBillingPlan/u);
  assert.match(checkout, /selectedPlan\.displayName/u);
  for (const document of [terms, contact, members]) {
    assert.match(document, /980円/u);
    assert.match(document, /2,980円/u);
    assert.match(document, /300円/u);
    assert.match(document, /自動更新/u);
  }
  assert.match(index, /lightPlan\.priceLabel/u);
  assert.match(index, /自動更新/u);
  assert.match(commerce, /BILLING_PLANS\.light\.priceLabel/u);
  assert.match(commerce, /自動更新/u);
  for (const document of [terms, contact, members]) {
    assert.match(document, /ライト鑑定(?:月| 月)5回/u);
    assert.match(document, /音声鑑定(?:月| 月)3回/u);
    assert.match(document, /ライト鑑定(?:月| 月)20回/u);
    assert.match(document, /深掘り鑑定(?:月| 月)3回/u);
    assert.match(document, /音声鑑定(?:月| 月)10回/u);
  }
  assert.match(index, /lightPlan\.priceLabel/u);
  assert.match(index, /premiumPlan\.priceLabel/u);
  assert.match(index, /voicePlan\.priceLabel/u);
  assert.match(commerce, /BILLING_PLANS\.light\.lightMonthlyLimit/u);
  assert.match(commerce, /BILLING_PLANS\.light\.voiceMonthlyLimit/u);
  assert.match(join, /getPublicCheckoutHref/u);
  assert.match(members, /checkout\?plan=premium/u);
  assert.match(members, /checkout\?plan=voice_single/u);
  assert.doesNotMatch(terms, /\blight鑑定\b|\bdeep鑑定\b/u);
});
