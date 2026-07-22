import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const EXIT = Object.freeze({ PASS: 0, SECURITY_FAIL: 1, CONFIG_ERROR: 2, NETWORK_ERROR: 3, BLOCKED: 4 });
export const PRODUCTION_HOSTS = new Set(["nana-fortune.com", "www.nana-fortune.com"]);
export const SOURCE_ROUTE = "/about";
export const TARGET_ROUTE = "/types";
const SOURCE_MARKERS = ["白音七とは"];
const TARGET_MARKERS = ["白音七 属性診断"];
const USER_AGENT = "shirone-preview-security-probe/1";
const AUTOMATION_BYPASS_HEADER = "x-vercel-protection-bypass";
const SAFE_HEADERS = [
  "content-type", "location", "cache-control", "vary", "x-content-type-options",
  "referrer-policy", "content-security-policy", "strict-transport-security", "x-frame-options",
  "x-vercel-cache",
];

export class ProbeConfigError extends Error {}
export class ProbeNetworkError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseAllowedHosts(value = "") {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function validatePreviewBaseUrl(input, { allowedHosts = new Set() } = {}) {
  if (typeof input !== "string" || input.trim() === "") throw new ProbeConfigError("Preview URL is required");
  let url;
  try { url = new URL(input); } catch { throw new ProbeConfigError("Preview URL is invalid"); }

  const rawAuthority = input.match(/^https:\/\/([^/]+)/i)?.[1] ?? "";
  if (url.protocol !== "https:") throw new ProbeConfigError("Only HTTPS Preview URLs are allowed");
  if (url.username || url.password) throw new ProbeConfigError("Credentials in Preview URL are forbidden");
  if (url.port && url.port !== "443") throw new ProbeConfigError("Non-default ports are forbidden");
  if (url.pathname !== "/" || url.search || url.hash) throw new ProbeConfigError("Preview base URL must not include path, query, or fragment");
  if (rawAuthority.replace(/:\d+$/, "").endsWith(".")) throw new ProbeConfigError("Trailing-dot hostnames are forbidden");
  if (!/^[\x00-\x7F]+$/.test(rawAuthority)) throw new ProbeConfigError("Unicode hostnames are forbidden");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (PRODUCTION_HOSTS.has(hostname)) throw new ProbeConfigError("Production hostname is forbidden");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ProbeConfigError("Local hostnames are forbidden");
  }
  if (isIP(hostname)) throw new ProbeConfigError("IP addresses are forbidden");
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) throw new ProbeConfigError("Punycode hostnames are forbidden");

  const vercelPreview = hostname.endsWith(".vercel.app") && hostname !== "vercel.app";
  if (!vercelPreview && !allowedHosts.has(hostname)) throw new ProbeConfigError("Hostname is not an allowed Preview target");

  return new URL(`https://${hostname}/`);
}

function extractTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) ?? "";
}

function extractCanonical(html) {
  return html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1] ?? "";
}

function extractAttribute(tag, name) {
  const quoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return quoted[2];
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1] ?? "";
}

function srcsetUrls(value) {
  return value.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

function isOptimizedImageCandidate(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/_astro/")) return false;
    return !/\.(?:css|m?js|map|woff2?|ttf|otf|eot)(?:$|[?#])/i.test(`${url.pathname}${url.search}`);
  } catch { return false; }
}

function extractOptimizedImageAsset(html, baseUrl) {
  const candidates = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = extractAttribute(tag, "src");
    if (src) candidates.push(src);
    candidates.push(...srcsetUrls(extractAttribute(tag, "srcset")));
  }
  for (const picture of html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) ?? []) {
    for (const tag of picture.match(/<source\b[^>]*>/gi) ?? []) {
      candidates.push(...srcsetUrls(extractAttribute(tag, "srcset")));
    }
  }
  const selected = candidates.find((candidate) => isOptimizedImageCandidate(candidate, baseUrl));
  if (!selected) return "";
  const url = new URL(selected, baseUrl);
  return `${url.pathname}${url.search}`.slice(0, 512);
}

function safeLocation(value, baseUrl) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    const hostClass = PRODUCTION_HOSTS.has(url.hostname.toLowerCase()) ? "production" :
      url.hostname.toLowerCase() === baseUrl.hostname ? "same_preview" : "other";
    const pathClass = url.pathname === TARGET_ROUTE ? "target_route" :
      url.pathname === "/sso-api" ? "vercel_sso" : "other";
    return { hostClass, pathClass };
  } catch { return { hostClass: "invalid", pathClass: "invalid" }; }
}

async function requestOnce(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, redirect: "manual", signal: controller.signal });
  } finally { clearTimeout(timer); }
}

async function requestWithSingleNetworkRetry(fetchImpl, url, options, timeoutMs) {
  let retried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return { response: await requestOnce(fetchImpl, url, options, timeoutMs), retried }; }
    catch (error) {
      if (attempt === 1) throw new ProbeNetworkError(error?.name === "AbortError" ? "Request timed out" : "Network request failed");
      retried = true;
    }
  }
}

async function observe(fetchImpl, baseUrl, { id, method, route, headerOverride, queryOverride }, timeoutMs, automationBypassSecret) {
  const url = new URL(route, baseUrl);
  url.searchParams.set("_shirone_probe", randomUUID());
  if (queryOverride) url.searchParams.set("x_astro_path", queryOverride);
  const headers = {
    "cache-control": "no-cache", pragma: "no-cache", "user-agent": USER_AGENT,
    ...(method === "POST" ? { "content-type": "application/json", origin: baseUrl.origin } : {}),
    ...(headerOverride ? { "x-astro-path": headerOverride } : {}),
    ...(automationBypassSecret ? { [AUTOMATION_BYPASS_HEADER]: automationBypassSecret } : {}),
  };
  const { response, retried } = await requestWithSingleNetworkRetry(
    fetchImpl, url, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }, timeoutMs,
  );
  const body = await response.text();
  const exposeShortText = response.status < 500;
  const selectedHeaders = {};
  for (const name of SAFE_HEADERS) {
    const value = response.headers.get(name);
    if (value && name !== "location") selectedHeaders[name] = value.slice(0, 256);
  }
  return {
    id, method, route, status: response.status, retried,
    bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body),
    sourceMarkers: exposeShortText ? SOURCE_MARKERS.filter((marker) => body.includes(marker)) : [],
    targetMarkers: exposeShortText ? TARGET_MARKERS.filter((marker) => body.includes(marker)) : [],
    title: exposeShortText ? extractTag(body, "title") : "", heading: exposeShortText ? extractTag(body, "h1") : "",
    canonicalPath: exposeShortText ? (() => { try { return new URL(extractCanonical(body), baseUrl).pathname; } catch { return ""; } })() : "",
    assetPath: exposeShortText ? extractOptimizedImageAsset(body, baseUrl) : "",
    stackTraceDetected: /node:internal|\bat\s+[^\n]+:\d+:\d+|<pre[^>]*>\s*(?:Error|TypeError|ReferenceError):/i.test(body),
    location: safeLocation(response.headers.get("location"), baseUrl), selectedHeaders,
  };
}

function sameRouteBehavior(actual, baseline) {
  if (actual.targetMarkers.length > 0) return false;
  if (actual.location?.pathClass === "target_route") return false;
  return actual.status === baseline.status && actual.sourceMarkers.length === baseline.sourceMarkers.length &&
    actual.title === baseline.title && actual.heading === baseline.heading && actual.canonicalPath === baseline.canonicalPath;
}

function isPreviewProtection(observation) {
  if (observation.location?.hostClass === "other" && observation.location.pathClass === "vercel_sso") return true;
  return [401, 403].includes(observation.status) && observation.sourceMarkers.length === 0 &&
    (/vercel|authentication|authorization/i.test(`${observation.title} ${observation.heading}`) ||
      observation.selectedHeaders["cache-control"]?.includes("no-store"));
}

function smokeOutcome(item, expectedStatus, expectedType) {
  const contentType = item.selectedHeaders["content-type"] ?? "";
  if (item.location?.hostClass === "production" || item.stackTraceDetected) return "FAIL";
  if (item.status !== expectedStatus) return "FAIL";
  if (expectedType === "image/" && !contentType.toLowerCase().startsWith("image/")) return "FAIL";
  if (expectedType && expectedType !== "image/" && !contentType.toLowerCase().includes(expectedType)) return "FAIL";
  return "PASS";
}

async function runSmoke(fetchImpl, target, timeoutMs, automationBypassSecret) {
  const specs = [
    ["SMOKE-TOP", "/", 200, "text/html"], ["SMOKE-TYPES", "/types", 200, "text/html"],
    ["SMOKE-MDX", "/blog/using-mdx", 200, "text/html"], ["SMOKE-RSS", "/rss.xml", 200, "xml"],
    ["SMOKE-SITEMAP", "/sitemap-index.xml", 200, "xml"], ["SMOKE-FAVICON", "/favicon.svg", 200, "image/svg"],
    ["SMOKE-PUBLIC-IMAGE", "/images/shirone-nana-hero.webp", 200, "image/"],
    ["SMOKE-LOGIN", "/login", 200, "text/html"], ["SMOKE-HISTORY", "/history", 200, "text/html"],
    ["SMOKE-RESULT", "/result", 200, "text/html"], ["SMOKE-404", "/__shirone_preview_probe_not_found__", 404, "text/html"],
  ];
  const output = [];
  for (const [id, route, expectedStatus, expectedType] of specs) {
    const item = await observe(fetchImpl, target, { id, method: "GET", route }, timeoutMs, automationBypassSecret);
    output.push({ ...item, outcome: smokeOutcome(item, expectedStatus, expectedType) });
  }
  const mdx = output.find((item) => item.id === "SMOKE-MDX");
  if (mdx?.assetPath) {
    const image = await observe(fetchImpl, target, { id: "SMOKE-ASTRO-IMAGE", method: "GET", route: mdx.assetPath }, timeoutMs, automationBypassSecret);
    output.push({ ...image, outcome: smokeOutcome(image, 200, "image/") });
  } else {
    output.push({
      id: "SMOKE-ASTRO-IMAGE", method: "GET", route: "derived-from-mdx",
      outcome: "NOT_APPLICABLE", reason: "NOT_APPLICABLE_NO_OPTIMIZED_IMAGE",
    });
  }
  return output;
}

export async function runPreviewProbe({ baseUrl, allowedHosts = new Set(), fetchImpl = fetch, timeoutMs = 15_000, includeSmoke = true } = {}) {
  const target = validatePreviewBaseUrl(baseUrl, { allowedHosts });
  const automationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined;
  const automationBypassConfigured = Boolean(automationBypassSecret);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 30_000) throw new ProbeConfigError("timeoutMs must be an integer from 10000 to 30000");

  const matrix = [
    { id: "BASE-GET-A", method: "GET", route: SOURCE_ROUTE },
    { id: "BASE-POST-A", method: "POST", route: SOURCE_ROUTE },
    { id: "BASE-GET-B", method: "GET", route: TARGET_ROUTE },
    { id: "PO-01", method: "GET", route: SOURCE_ROUTE, headerOverride: TARGET_ROUTE },
    { id: "PO-02", method: "POST", route: SOURCE_ROUTE, headerOverride: TARGET_ROUTE },
    { id: "PO-03", method: "GET", route: SOURCE_ROUTE, queryOverride: TARGET_ROUTE },
    { id: "PO-04", method: "POST", route: SOURCE_ROUTE, queryOverride: TARGET_ROUTE },
  ];
  const observations = [await observe(fetchImpl, target, matrix[0], timeoutMs, automationBypassSecret)];
  const baselineGet = observations[0];
  if (baselineGet.location?.hostClass === "production") return result("BLOCKED_BY_DEPLOYMENT_CONFIGURATION", EXIT.BLOCKED, target, observations, automationBypassConfigured);
  if (isPreviewProtection(baselineGet)) return result("BLOCKED_BY_PREVIEW_PROTECTION", EXIT.BLOCKED, target, observations, automationBypassConfigured);
  if (baselineGet.location?.hostClass === "other") return result("BLOCKED_BY_DEPLOYMENT_CONFIGURATION", EXIT.BLOCKED, target, observations, automationBypassConfigured);
  for (const item of matrix.slice(1)) observations.push(await observe(fetchImpl, target, item, timeoutMs, automationBypassSecret));
  const baselinePost = observations.find((item) => item.id === "BASE-POST-A");

  const tests = observations.map((item) => {
    if (!item.id.startsWith("PO-")) return { ...item, outcome: "BASELINE" };
    const baseline = item.method === "POST" ? baselinePost : baselineGet;
    return { ...item, outcome: sameRouteBehavior(item, baseline) ? "PASS" : "FAIL" };
  });
  if (includeSmoke) tests.push(...await runSmoke(fetchImpl, target, timeoutMs, automationBypassSecret));
  const failed = tests.some((item) => item.outcome === "FAIL");
  return result(failed ? "SECURITY_REMEDIATION_FAILED" : "VERCEL_PREVIEW_REMEDIATION_VERIFIED", failed ? EXIT.SECURITY_FAIL : EXIT.PASS, target, tests, automationBypassConfigured);
}

function result(verdict, exitCode, target, tests, automationBypassConfigured) {
  const counts = { pass: 0, fail: 0, notApplicable: 0, blocked: 0, error: 0 };
  for (const item of tests) {
    if (item.outcome === "PASS") counts.pass += 1;
    if (item.outcome === "FAIL") counts.fail += 1;
    if (item.outcome === "NOT_APPLICABLE") counts.notApplicable += 1;
  }
  if (exitCode === EXIT.BLOCKED) counts.blocked = 1;
  return {
    schema: "shirone-vercel-preview-security-validation-v1",
    testedAt: new Date().toISOString(), targetClass: "vercel_preview",
    targetHostSha256: sha256(target.hostname), productionHostRejected: true,
    automation_bypass_configured: automationBypassConfigured,
    tests, summary: counts, verdict, exitCode,
  };
}

function parseCli(argv) {
  const index = argv.indexOf("--base-url");
  const baseUrl = index >= 0 ? argv[index + 1] : process.env.VERCEL_PREVIEW_URL;
  return { baseUrl, allowedHosts: parseAllowedHosts(process.env.VERCEL_PREVIEW_ALLOWED_HOSTS) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = await runPreviewProbe(parseCli(process.argv.slice(2)));
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = output.exitCode;
  } catch (error) {
    const config = error instanceof ProbeConfigError;
    console.error(JSON.stringify({ schema: "shirone-vercel-preview-security-validation-error-v1", error: config ? "CONFIG_ERROR" : error instanceof ProbeNetworkError ? "NETWORK_ERROR" : "UNEXPECTED_ERROR" }));
    process.exitCode = config ? EXIT.CONFIG_ERROR : error instanceof ProbeNetworkError ? EXIT.NETWORK_ERROR : EXIT.SECURITY_FAIL;
  }
}
