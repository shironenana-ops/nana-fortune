export type PublicRuntimeEnvironment = "production" | "local-staging";

export type PublicRuntimeApiConfig = {
  environment: PublicRuntimeEnvironment;
  stagingIndicator: boolean;
  authEnabled: boolean;
  loginUrl: string | null;
  signupUrl: string | null;
  membershipStatusUrl: string | null;
  readingUrl: string | null;
  readingStatusUrl: string | null;
  historyBaseUrl: string | null;
};

type PublicEnv = Record<string, unknown>;

function text(env: PublicEnv, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function boolean(env: PublicEnv, name: string, fallback = false): boolean {
  const value = text(env, name);
  if (!value) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name}_INVALID`);
  return value === "true";
}

function baseUrl(value: string, name: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name}_INVALID`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name}_INVALID`);
  return url.href.replace(/\/$/u, "");
}

function stagingBaseUrl(value: string): string {
  const base = baseUrl(value, "PUBLIC_STAGING_API_BASE_URL");
  if (!base) throw new Error("PUBLIC_STAGING_API_BASE_URL_REQUIRED");
  const url = new URL(base);
  if (!url.hostname.endsWith(".execute-api.ap-northeast-1.amazonaws.com") || url.pathname !== "/staging" || /prod|production/iu.test(base)) {
    throw new Error("PUBLIC_STAGING_API_BASE_URL_INVALID");
  }
  return base;
}

function endpoint(base: string | null, path: string): string | null {
  return base ? `${base}${path}` : null;
}

export function resolvePublicRuntimeApiConfig(env: PublicEnv): PublicRuntimeApiConfig {
  const environment = text(env, "PUBLIC_RUNTIME_ENV") || "production";
  if (environment !== "production" && environment !== "local-staging") throw new Error("PUBLIC_RUNTIME_ENV_INVALID");

  if (environment === "local-staging") {
    const base = stagingBaseUrl(text(env, "PUBLIC_STAGING_API_BASE_URL"));
    return {
      environment,
      stagingIndicator: true,
      authEnabled: boolean(env, "PUBLIC_STAGING_AUTH_ENABLED", false),
      loginUrl: endpoint(base, "/login"),
      signupUrl: endpoint(base, "/signup"),
      membershipStatusUrl: endpoint(base, "/membership/status"),
      readingUrl: endpoint(base, "/reading"),
      readingStatusUrl: endpoint(base, "/reading/status"),
      historyBaseUrl: null,
    };
  }

  const authBase = baseUrl(text(env, "PUBLIC_AUTH_API_BASE_URL"), "PUBLIC_AUTH_API_BASE_URL");
  const readingBase = baseUrl(text(env, "PUBLIC_READING_API_BASE_URL"), "PUBLIC_READING_API_BASE_URL");
  const membershipStatusUrl = baseUrl(text(env, "PUBLIC_CANONICAL_MEMBERSHIP_STATUS_URL"), "PUBLIC_CANONICAL_MEMBERSHIP_STATUS_URL");
  const historyBase = baseUrl(text(env, "PUBLIC_HISTORY_API_BASE_URL"), "PUBLIC_HISTORY_API_BASE_URL");
  return {
    environment,
    stagingIndicator: false,
    authEnabled: boolean(env, "PUBLIC_AUTH_ENABLED", Boolean(authBase)),
    loginUrl: endpoint(authBase, "/login"),
    signupUrl: endpoint(authBase, "/signup"),
    membershipStatusUrl,
    readingUrl: endpoint(readingBase, "/reading"),
    readingStatusUrl: endpoint(readingBase, "/reading/status"),
    historyBaseUrl: historyBase,
  };
}
