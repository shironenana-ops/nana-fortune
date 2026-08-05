import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildRuntimeApiConfig } from "../scripts/build-runtime-api-config.mjs";

await buildRuntimeApiConfig();
const api = await import(`${new URL("../dist/runtime-api-config/index.mjs", import.meta.url).href}?runtime-api=${Date.now()}`);
const stagingBase = "https://fixture.execute-api.ap-northeast-1.amazonaws.com/staging";

test("local-stagingはauth/membership/reading/statusを同じstaging baseへ向ける", () => {
  const config = api.resolvePublicRuntimeApiConfig({
    PUBLIC_RUNTIME_ENV: "local-staging",
    PUBLIC_STAGING_API_BASE_URL: stagingBase,
    PUBLIC_STAGING_AUTH_ENABLED: "true",
  });
  assert.equal(config.loginUrl, `${stagingBase}/login`);
  assert.equal(config.signupUrl, `${stagingBase}/signup`);
  assert.equal(config.membershipStatusUrl, `${stagingBase}/membership/status`);
  assert.equal(config.readingUrl, `${stagingBase}/reading`);
  assert.equal(config.readingStatusUrl, `${stagingBase}/reading/status`);
  assert.equal(config.historyBaseUrl, null);
  assert.equal(config.stagingIndicator, true);
});

test("local-staging authは既定falseで、base欠落・prod path・別regionを拒否する", () => {
  assert.equal(api.resolvePublicRuntimeApiConfig({ PUBLIC_RUNTIME_ENV: "local-staging", PUBLIC_STAGING_API_BASE_URL: stagingBase }).authEnabled, false);
  assert.throws(() => api.resolvePublicRuntimeApiConfig({ PUBLIC_RUNTIME_ENV: "local-staging" }), /PUBLIC_STAGING_API_BASE_URL_REQUIRED/u);
  assert.throws(() => api.resolvePublicRuntimeApiConfig({ PUBLIC_RUNTIME_ENV: "local-staging", PUBLIC_STAGING_API_BASE_URL: stagingBase.replace("/staging", "/prod") }), /INVALID/u);
  assert.throws(() => api.resolvePublicRuntimeApiConfig({ PUBLIC_RUNTIME_ENV: "local-staging", PUBLIC_STAGING_API_BASE_URL: stagingBase.replace("ap-northeast-1", "us-east-1") }), /INVALID/u);
});

test("production endpointは環境設定だけから解決し、固定fallbackを持たない", () => {
  const empty = api.resolvePublicRuntimeApiConfig({ PUBLIC_RUNTIME_ENV: "production" });
  assert.equal(empty.authEnabled, false);
  assert.equal(empty.loginUrl, null);
  assert.equal(empty.signupUrl, null);
  assert.equal(empty.membershipStatusUrl, null);
  assert.equal(empty.historyBaseUrl, null);
  const configured = api.resolvePublicRuntimeApiConfig({
    PUBLIC_RUNTIME_ENV: "production",
    PUBLIC_AUTH_API_BASE_URL: "https://auth.example.invalid",
    PUBLIC_AUTH_ENABLED: "true",
    PUBLIC_READING_API_BASE_URL: "https://reading.example.invalid",
    PUBLIC_CANONICAL_MEMBERSHIP_STATUS_URL: "https://membership.example.invalid/status",
    PUBLIC_HISTORY_API_BASE_URL: "https://history.example.invalid",
  });
  assert.equal(configured.authEnabled, true);
  assert.equal(configured.loginUrl, "https://auth.example.invalid/login");
  assert.equal(configured.signupUrl, "https://auth.example.invalid/signup");
  assert.equal(configured.membershipStatusUrl, "https://membership.example.invalid/status");
  assert.equal(configured.historyBaseUrl, "https://history.example.invalid");
});

test("login/signupはproductionとstagingで同じauth契約を使い、redirectとlogoutを安全に維持する", async () => {
  const login = await readFile("src/pages/login.astro", "utf8");
  const signup = await readFile("src/pages/signup.astro", "utf8");

  for (const page of [login, signup]) {
    assert.match(page, /const authEnabled = runtimeApi\.authEnabled/u);
    assert.doesNotMatch(page, /stagingAuthEnabled/u);
    assert.doesNotMatch(page, /execute-api\.ap-northeast-1\.amazonaws\.com/u);
    assert.doesNotMatch(page, /console\.(?:log|info|debug)\([^)]*(?:password|token|email|data)/iu);
  }

  assert.match(login, /const redirect = params\.get\("redirect"\) \|\| "\/members"/u);
  assert.match(login, /window\.location\.href = redirect \|\| "\/members"/u);
  for (const key of ["token", "loginEmail", "userId", "user_id"]) {
    assert.match(login, new RegExp(`localStorage\\.removeItem\\("${key}"\\)`, "u"));
  }
});

test("frontendは固定execute-api URLを持たず単一runtime configを参照する", async () => {
  const files = [
    "src/pages/login.astro", "src/pages/signup.astro", "src/pages/members.astro", "src/pages/premium.astro",
    "src/pages/history/index.astro", "src/pages/history/[id].astro", "src/pages/result.astro", "src/pages/verify-email.astro",
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /[a-z0-9]+\.execute-api\.ap-northeast-1\.amazonaws\.com/u);
  assert.match(source, /runtimeApiConfig/u);
  assert.doesNotMatch(source, /現在このテスト環境では鑑定履歴/u);
});

test("履歴の保存・一覧・詳細はproduction設定とBearer認証だけを使用する", async () => {
  const result = await readFile("src/pages/result.astro", "utf8");
  const list = await readFile("src/pages/history/index.astro", "utf8");
  const detail = await readFile("src/pages/history/[id].astro", "utf8");
  const source = [result, list, detail].join("\n");

  assert.match(result, /historyBaseUrl \? `\$\{historyBaseUrl\}\/history` : ""/u);
  assert.match(list, /Authorization: "Bearer " \+ token/u);
  assert.match(detail, /Authorization: "Bearer " \+ token/u);
  assert.doesNotMatch(source, /[?&]user_id=/u);
  assert.doesNotMatch(source, /\/user\/status/u);
  assert.doesNotMatch(source, /PUBLIC_STAGING_API_BASE_URL/u);
});
