import assert from "node:assert/strict";
import test from "node:test";
import {
  EXIT, ProbeConfigError, parseAllowedHosts, runPreviewProbe, validatePreviewBaseUrl,
} from "../scripts/security/probeVercelPreviewPathOverride.mjs";

const PREVIEW = "https://nana-fortune-git-security-example.vercel.app/";

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

function html(title, heading, canonical) {
  return `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${canonical}"></head><body><h1>${heading}</h1></body></html>`;
}

function safeMock({ vulnerable = false, protection = false, productionRedirect = false } = {}) {
  return async (input, init) => {
    const url = new URL(input);
    if (productionRedirect) return new Response("", { status: 307, headers: { location: "https://www.nana-fortune.com/about" } });
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
  let redirectCalls = 0;
  const redirected = await runPreviewProbe({ baseUrl: PREVIEW, fetchImpl: async (...args) => { redirectCalls += 1; return safeMock({ productionRedirect: true })(...args); }, includeSmoke: false });
  assert.equal(redirected.verdict, "BLOCKED_BY_DEPLOYMENT_CONFIGURATION");
  assert.equal(redirected.exitCode, EXIT.BLOCKED);
  assert.equal(redirectCalls, 1);
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
