export function allowFincodeTestRedirectUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "api.test.fincode.jp" || url.hostname === "simulator.test.fincode.jp")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
