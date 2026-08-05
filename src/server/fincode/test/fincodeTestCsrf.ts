const LOCAL_TEST_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FINCODE_TEST_RESULT_PATH = "/fincode/test/result";

export function isLocalFincodeTestReturn(request: Request): boolean {
  if (request.method !== "POST") return false;

  const url = new URL(request.url);
  return (
    (url.protocol === "http:" || url.protocol === "https:")
    && LOCAL_TEST_HOSTS.has(url.hostname)
    && url.pathname === FINCODE_TEST_RESULT_PATH
  );
}
