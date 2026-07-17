import { createHmac, timingSafeEqual } from "node:crypto";
import { ServerFoundationError } from "../http/errors";

export type SessionTokenPayload = { user_id: string; iat: number; exp: number };
export type HeaderValue = string | string[] | undefined;
export type HeaderMap = Record<string, HeaderValue>;

function getHeader(headers: HeaderMap, name: string): HeaderValue {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

export function parseAuthorizationHeader(headers: HeaderMap): string {
  const value = getHeader(headers, "Authorization");
  if (value === undefined || value === "") throw new ServerFoundationError("AUTH_MISSING");
  if (Array.isArray(value)) throw new ServerFoundationError("AUTH_INVALID_SCHEME");
  if (/\r|\n/.test(value) || !value.startsWith("Bearer ")) {
    throw new ServerFoundationError("AUTH_INVALID_SCHEME");
  }
  const token = value.replace("Bearer ", "").trim();
  if (!token || token.length > 4096) throw new ServerFoundationError("AUTH_INVALID_TOKEN");
  return token;
}

function decodeBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new ServerFoundationError("AUTH_INVALID_TOKEN");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new ServerFoundationError("AUTH_INVALID_TOKEN");
  return decoded;
}

export function verifySessionToken(params: {
  token: string;
  secret?: string;
  nowEpochSeconds?: number;
}): SessionTokenPayload {
  const { token, secret } = params;
  if (!secret) throw new ServerFoundationError("AUTH_NOT_CONFIGURED");
  if (!token || token.length > 4096 || token.split(".").length !== 2) {
    throw new ServerFoundationError("AUTH_INVALID_TOKEN");
  }
  const [payloadPart, signaturePart] = token.split(".");
  const actual = decodeBase64Url(signaturePart);
  const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payloadPart, "utf8")
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ServerFoundationError("AUTH_INVALID_TOKEN");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(payloadPart).toString("utf8"));
  } catch (error) {
    if (error instanceof ServerFoundationError) throw error;
    throw new ServerFoundationError("AUTH_INVALID_PAYLOAD");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ServerFoundationError("AUTH_INVALID_PAYLOAD");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.user_id !== "string" || value.user_id.length === 0) {
    throw new ServerFoundationError("AUTH_INVALID_PAYLOAD");
  }
  if (!Number.isInteger(value.iat) || !Number.isInteger(value.exp)) {
    throw new ServerFoundationError("AUTH_INVALID_PAYLOAD");
  }
  const now = params.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if ((value.exp as number) < now) throw new ServerFoundationError("AUTH_EXPIRED");
  return value as SessionTokenPayload;
}

export function authenticateHeaders(params: {
  headers: HeaderMap;
  secret?: string;
  nowEpochSeconds?: number;
}): SessionTokenPayload {
  return verifySessionToken({
    token: parseAuthorizationHeader(params.headers),
    secret: params.secret,
    nowEpochSeconds: params.nowEpochSeconds,
  });
}
