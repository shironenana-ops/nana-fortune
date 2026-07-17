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
const resolutionUrl = await compileModule("../src/lib/readingModeResolution.ts", {
  "./membershipEntitlements": entitlementsUrl,
});
const { normalizeReadingMode, resolveReadingMode } = await import(resolutionUrl);

const active = (plan, extra = {}) => ({ plan, subscription_status: "active", ...extra });

test("会員プランと鑑定モードの正規化を混同しない", async () => {
  const { normalizeMembershipTier } = await import(membershipUrl);
  assert.equal(normalizeMembershipTier("free"), "free");
  assert.equal(normalizeMembershipTier("light"), "light");
  assert.equal(normalizeMembershipTier("premium"), "premium");
  assert.equal(normalizeMembershipTier("normal"), "light");
  assert.equal(normalizeMembershipTier("member"), "light");
  assert.equal(normalizeMembershipTier("unknown"), "free");
  assert.equal(normalizeReadingMode("free"), "free");
  assert.equal(normalizeReadingMode("light"), "light");
  assert.equal(normalizeReadingMode("deep"), "deep");
  assert.equal(normalizeReadingMode("premium"), null);
});

test("未ログインとfree会員はfreeだけを利用できる", () => {
  for (const membership of [null, { plan: "free" }]) {
    assert.equal(resolveReadingMode({ requestedMode: "free", membership }).allowed, true);
    for (const mode of ["light", "deep"]) {
      const result = resolveReadingMode({ requestedMode: mode, membership });
      assert.equal(result.allowed, false);
      assert.equal(result.resolvedMode, "free");
    }
  }
});

test("activeなlight会員はfreeとlightだけを利用できる", () => {
  assert.equal(resolveReadingMode({ requestedMode: "free", membership: active("light") }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "light", membership: active("light") }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership: active("light") }).allowed, false);
  assert.equal(resolveReadingMode({ membership: active("light") }).resolvedMode, "light");
});

test("inactiveなlight会員はfreeだけを利用できる", () => {
  const membership = { plan: "light", subscription_status: "inactive" };
  assert.equal(resolveReadingMode({ requestedMode: "free", membership }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "light", membership }).allowed, false);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership }).allowed, false);
});

test("activeなpremium会員の標準はlightで、deepは権利と明示選択を必要とする", () => {
  const withoutDeep = active("premium", { deep_enabled: false });
  const withDeep = active("premium", { deep_enabled: true });

  assert.equal(resolveReadingMode({ requestedMode: "free", membership: withoutDeep }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "light", membership: withoutDeep }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership: withoutDeep }).allowed, false);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership: withDeep }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership: withDeep }).resolvedMode, "deep");
  assert.equal(resolveReadingMode({ membership: withDeep }).resolvedMode, "light");
});

test("inactiveなpremium会員はdeep_enabledがtrueでもfreeだけ", () => {
  const membership = { plan: "premium", subscription_status: "inactive", deep_enabled: true };
  assert.equal(resolveReadingMode({ requestedMode: "free", membership }).allowed, true);
  assert.equal(resolveReadingMode({ requestedMode: "light", membership }).allowed, false);
  assert.equal(resolveReadingMode({ requestedMode: "deep", membership }).allowed, false);
});

test("不明modeは拒否され、deepへ昇格しない", () => {
  const result = resolveReadingMode({
    requestedMode: "premium",
    membership: active("premium", { deep_enabled: true }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.resolvedMode, "free");
  assert.equal(result.reason, "unknown_mode");
});

test("URL・localStorage・旧Stripe属性だけでは昇格しない", () => {
  const untrustedOnly = {
    requestedMode: "deep",
    membership: {
      urlPlan: "premium",
      localStoragePlan: "premium",
      stripe_customer_id: "legacy",
      stripe_subscription_status: "active",
      deep_enabled: true,
    },
  };
  const result = resolveReadingMode(untrustedOnly);
  assert.equal(result.tier, "free");
  assert.equal(result.allowed, false);
  assert.equal(result.resolvedMode, "free");
});

test("解決モジュールはURL・Storage・Stripeを参照しない", () => {
  const source = fs.readFileSync(new URL("../src/lib/readingModeResolution.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /URLSearchParams|location\.|localStorage|sessionStorage|stripe_/i);
  assert.match(source, /getMembershipEntitlements/);
});
