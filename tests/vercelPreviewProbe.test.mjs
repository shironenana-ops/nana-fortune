import assert from "node:assert/strict";
import test from "node:test";
import {
  EXIT, ProbeConfigError, parseAllowedHosts, runPreviewProbe, validatePreviewBaseUrl,
} from "../scripts/security/probeVercelPreviewPathOverride.mjs";

const PREVIEW = "https://nana-fortune-git-security-example.vercel.app/";
const FAKE_BYPASS_SECRET = "fake-test-bypass-secret-never-real";

async function withBypassSecret(value, action) {
  const previous = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    if (value === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = value;
    return await action();
  } finally {
    if (previous === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previous;
  }
}

test("URL guard rejects production, local, IP, HTTP, credentials and URL suffixes without fetching", async () => {
  const invalid = [
    "https://nana-fortune.com/", "https://www.nana-fortune.com/", "http://demo.vercel.app/",
    "https://localhost/", "https://127.0.0.1/", "https://192.168.1.2/", "https://8.8.8.8/", "https://[::1]/",
    "https://user:pass@demo.vercel.app/", "https://demo.vercel.app/path", "https://demo.vercel.app/?x=1",
    "https://demo.vercel.app/#fragment", "https://demo.vercel.app./", "https://é.vercel.app/", "https://xn--9ca.vercel.app/",
  ];
  for (const value of invalid) assert.throws(() => validatePreviewBaseUrl(value), ProbeConfigError);
  let calls = 0;
  await assert.rejects(() => runPreviewProbe({ baseUrl: "https://nana-fortune.com/", fetchImpl: async () => { calls += 1; } }), ProbeConfigError);
  assert.equal(calls, 0);
});

test("URL guard accepts normalized Vercel Preview and explicit staging allowlist", () => {
  assert.equal(validatePreviewBaseUrl("https://NANA-FORTUNE-GIT-X.VERCEL.APP:443/").hostname, "nana-fortune-git-x.vercel.app");
  const allowedHosts = parseAllowedHosts("preview.example.test");
  assert.equal(validatePreviewBaseUrl("https://preview.example.test/", { allowedHosts }).hostname, "preview.example.test");
});

test("automation bypass is read only from the environment and never appears in output", async () => {
  const received = [];
  const output = await withBypassSecret(FAKE_BYPASS_SECRET, () => runPreviewProbe({
    baseUrl: PREVIEW,
    includeSmoke: false,
    fetchImpl: async (input, init) => {
      received.push({ url: new URL(input), headers: init.headers });
      return safeMock()(input, init);
    },
  }));
  assert.equal(output.automation_bypass_configured, true);
  assert.equal(received.length, 7);
  assert.equal(received.every(({ url, headers }) => url.hostname.endsWith(".vercel.app") && headers["x-vercel-protection-bypass"] === FAKE_BYPASS_SECRET), true);
  assert.equal(JSON.stringify(output).includes(FAKE_BYPASS_SECRET), false);
});

test("automation bypass is absent by default and is never sent to a rejected production URL", async () => {
  let previewHeader;
  const output = await withBypassSecret(undefined, () => runPreviewProbe({
    baseUrl: PREVIEW,
    includeSmoke: false,
    fetchImpl: async (input, init) => { previewHeader = init.headers["x-vercel-protection-bypass"]; return safeMock()(input, init); },
  }));
  assert.equal(output.automation_bypass_configured, false);
  assert.equal(previewHeader, undefined);

  let productionCalls = 0;
  await withBypassSecret(FAKE_BYPASS_SECRET, () => assert.rejects(
    () => runPreviewProbe({ baseUrl: "https://nana-fortune.com/", fetchImpl: async () => { productionCalls += 1; } }),
    ProbeConfigError,
  ));
  assert.equal(productionCalls, 0);
});

function html(title, heading, canonical) {
  return `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${canonical}"></head><body><h1>${heading}</h1></body></html>`;
}

function safeMock({ vulnerable = false, protection = false, ssoProtection = false, productionRedirect = false } = {}) {
  return async (input, init) => {
    const url = new URL(input);
    if (productionRedirect) return new Response("", { status: 307, headers: { location: "https://www.nana-fortune.com/about" } });
    if (ssoProtection) return new Response("Authentication Required", { status: 302, headers: { location: "https://vercel.com/sso-api?url=preview&nonce=secret-value", "x-vercel-id": "request-id-must-not-be-recorded" } });
    if (protection) return new Response("<title>Vercel Authentication</title>", { status: 401, headers: { "content-type": "text/html" } });
    const override = init.headers["x-astro-path"] || url.searchParams.get("x_astro_path");
    const route = vulnerable && override ? override : url.pathname;
    if (route === "/types") return new Response(html("属性一覧", "白音七 属性診断", "https://www.nana-fortune.com/types"), { status: 200, headers: { "content-type": "text/html" } });
    return new Response(html("白音七とは", "白音七とは", "https://www.nana-fortune.com/about"), { status: init.method === "POST" ? 405 : 200, headers: { "content-type": "text/html" } });
  };
}

test("four path override probes pass when source route behavior is preserved", async () => {
  const output = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: safeMock(), includeSmoke: false });
  assert.equal(output.verdict, "VERCEL_PREVIEW_REMEDIATION_VERIFIED");
  assert.equal(output.exitCode, EXIT.PASS);
  assert.equal(output.summary.pass, 4);
  assert.equal(output.summary.fail, 0);
  assert.equal(JSON.stringify(output).includes("nana-fortune-git-security-example.vercel.app"), false);
});

test("target route marker or redirect makes the security probe fail", async () => {
  const output = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: safeMock({ vulnerable: true }), includeSmoke: false });
  assert.equal(output.verdict, "SECURITY_REMEDIATION_FAILED");
  assert.equal(output.exitCode, EXIT.SECURITY_FAIL);
  assert.equal(output.summary.fail, 4);
});

test("Preview protection and production redirect are blocked, not passed", async () => {
  let protectionCalls = 0;
  const protectedOutput = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: async (...args) => { protectionCalls += 1; return safeMock({ protection: true })(...args); }, includeSmoke: false });
  assert.equal(protectedOutput.verdict, "BLOCKED_BY_PREVIEW_PROTECTION");
  assert.equal(protectedOutput.exitCode, EXIT.BLOCKED);
  assert.equal(protectionCalls, 1);
  let ssoCalls = 0;
  const ssoOutput = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: async (...args) => { ssoCalls += 1; return safeMock({ ssoProtection: true })(...args); }, includeSmoke: false });
  assert.equal(ssoOutput.verdict, "BLOCKED_BY_PREVIEW_PROTECTION");
  assert.equal(ssoOutput.exitCode, EXIT.BLOCKED);
  assert.equal(ssoCalls, 1);
  assert.equal(JSON.stringify(ssoOutput).includes("nonce"), false);
  assert.equal(JSON.stringify(ssoOutput).includes("request-id-must-not-be-recorded"), false);
  let redirectCalls = 0;
  const redirected = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: async (...args) => { redirectCalls += 1; return safeMock({ productionRedirect: true })(...args); }, includeSmoke: false });
  assert.equal(redirected.verdict, "BLOCKED_BY_DEPLOYMENT_CONFIGURATION");
  assert.equal(redirected.exitCode, EXIT.BLOCKED);
  assert.equal(redirectCalls, 1);
  let crossHostCalls = 0;
  const crossHost = await withBypassSecret(FAKE_BYPASS_SECRET, () => runPreviewProbe({
    baseUrl: PREVIEW,
    includeSmoke: false,
    fetchImpl: async (input, init) => {
      crossHostCalls += 1;
      assert.equal(init.headers["x-vercel-protection-bypass"], FAKE_BYPASS_SECRET);
      return new Response("", { status: 302, headers: { location: "https://example.invalid/elsewhere" } });
    },
  }));
  assert.equal(crossHost.verdict, "BLOCKED_BY_DEPLOYMENT_CONFIGURATION");
  assert.equal(crossHostCalls, 1);
  assert.equal(JSON.stringify(crossHost).includes(FAKE_BYPASS_SECRET), false);
});

test("smoke matrix checks pages, XML, assets, protected shells, 404 and derived Astro image", async () => {
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const route = url.pathname;
    if (route === "/__shirone_preview_probe_not_found__") return new Response("<title>404</title>", { status: 404, headers: { "content-type": "text/html" } });
    if (route === "/rss.xml" || route === "/sitemap-index.xml") return new Response("<?xml version=\"1.0\"?><root/>", { status: 200, headers: { "content-type": "application/xml" } });
    if (route === "/favicon.svg") return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
    if (route.startsWith("/images/") || route.startsWith("/_astro/")) return new Response("image", { status: 200, headers: { "content-type": "image/webp" } });
    if (route === "/types") return new Response(html("属性一覧", "白音七 属性診断", "https://www.nana-fortune.com/types"), { status: 200, headers: { "content-type": "text/html" } });
    const asset = route === "/blog/using-mdx" ? '<img src="/_astro/mdx-fixture.webp">' : "";
    return new Response(html("白音七とは", "白音七とは", `https://www.nana-fortune.com${route}`) + asset, { status: init.method === "POST" ? 405 : 200, headers: { "content-type": "text/html" } });
  };
  const output = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl });
  assert.equal(output.verdict, "VERCEL_PREVIEW_REMEDIATION_VERIFIED");
  assert.equal(output.tests.filter((item) => item.id.startsWith("SMOKE-") && item.outcome === "PASS").length, 12);
  assert.equal(output.tests.some((item) => item.stackTraceDetected), false);
});
