import { ServerFoundationError } from "./errors";

const ALLOWED_METHODS = new Set(["POST", "OPTIONS"]);
const ALLOWED_HEADERS = new Set(["content-type", "authorization", "idempotency-key"]);

function validOrigin(value: string): boolean {
  if (!value || value === "null" || value === "*" || /[\r\n,]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
}

export function parseAllowedOrigins(value?: string): ReadonlySet<string> {
  if (!value) throw new ServerFoundationError("CORS_NOT_CONFIGURED");
  const origins = value.split(",").map((item) => item.trim());
  if (!origins.length || origins.some((origin) => !validOrigin(origin))) {
    throw new ServerFoundationError("CORS_NOT_CONFIGURED");
  }
  return new Set(origins);
}

export function evaluateCors(params: {
  origin?: string;
  allowedOrigins: ReadonlySet<string>;
  method?: string;
  requestedHeaders?: string;
}) {
  if (params.origin === undefined) {
    return { allowed: true, headers: { Vary: "Origin" } };
  }
  if (!validOrigin(params.origin) || !params.allowedOrigins.has(params.origin)) {
    throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  }
  const method = (params.method ?? "POST").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  const requested = (params.requestedHeaders ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requested.some((header) => !ALLOWED_HEADERS.has(header))) {
    throw new ServerFoundationError("ORIGIN_NOT_ALLOWED");
  }
  return {
    allowed: true,
    headers: {
      "Access-Control-Allow-Origin": params.origin,
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,Idempotency-Key",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  };
}
