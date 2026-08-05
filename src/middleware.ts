import { defineMiddleware } from "astro:middleware";
import { isLocalFincodeTestReturn } from "./server/fincode/test/fincodeTestCsrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
];

function isFormLike(contentType: string | null): boolean {
  if (contentType === null) return false;
  const normalized = contentType.toLowerCase();
  return FORM_CONTENT_TYPES.some((allowed) => normalized.includes(allowed));
}

export const onRequest = defineMiddleware((context, next) => {
  if (!import.meta.env.DEV) return next();

  const { request, url, isPrerendered } = context;
  if (isPrerendered || SAFE_METHODS.has(request.method)) return next();
  if (isLocalFincodeTestReturn(request)) return next();

  const originMatches = request.headers.get("origin") === url.origin;
  const contentType = request.headers.get("content-type");
  const requiresOriginCheck = contentType === null || isFormLike(contentType);
  if (requiresOriginCheck && !originMatches) {
    return new Response(`Cross-site ${request.method} form submissions are forbidden`, { status: 403 });
  }

  return next();
});
