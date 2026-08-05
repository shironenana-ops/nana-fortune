import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const REGION = "ap-northeast-1";
const CUSTOMER_PREFIX = "stg_customer_";
const SECRET_ID = "shirone7/staging/fincode/test-provider";
const ORIGIN = "https://api.test.fincode.jp";
const CUSTOMER_IDS = [
  "stg_customer_e2e_light_20260803_00001",
  "stg_customer_e2e_premium_20260803_001",
];

if (process.argv[2] !== "--execute-staging-test" || process.env.AWS_PROFILE !== "shirone-staging" || process.env.AWS_REGION !== REGION) {
  throw new Error("STAGING_TEST_GUARD_REJECTED");
}

const secrets = new SecretsManagerClient({ region: REGION });
if (CUSTOMER_IDS.some((id) => !id.startsWith(CUSTOMER_PREFIX) || id.length < CUSTOMER_PREFIX.length + 24)) {
  throw new Error("STAGING_CUSTOMER_BOUNDARY_INVALID");
}
let secretText;
try {
  secretText = (await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString;
} catch {
  throw new Error("STAGING_TEST_PROVIDER_SECRET_UNAVAILABLE");
}

let provider;
try { provider = JSON.parse(secretText ?? ""); } catch { throw new Error("STAGING_TEST_PROVIDER_SECRET_INVALID"); }
secretText = undefined;
const key = provider?.fincode_test_secret_key;
const shop = provider?.fincode_test_shop_id;
if (typeof key !== "string" || !key.startsWith("m_test_") || typeof shop !== "string" || !/^s_[A-Za-z0-9_-]+$/u.test(shop)) {
  throw new Error("STAGING_TEST_PROVIDER_SECRET_INVALID");
}

async function request(path, init = {}) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error("FINCODE_TEST_ORIGIN_REJECTED");
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

let created = 0;
let existing = 0;
for (const id of CUSTOMER_IDS) {
  const found = await request(`/v1/customers/${encodeURIComponent(id)}`);
  if (found.status === 200 && found.body?.id === id) { existing += 1; continue; }
  if (found.status !== 400 && found.status !== 404) throw new Error("FINCODE_TEST_CUSTOMER_LOOKUP_FAILED");
  const result = await request("/v1/customers", { method: "POST", body: JSON.stringify({ id }) });
  if (result.status !== 200 || result.body?.id !== id) throw new Error("FINCODE_TEST_CUSTOMER_CREATE_FAILED");
  created += 1;
}

provider = undefined;
console.log(JSON.stringify({ environment: "TEST", customer_fixture_created: created, customer_fixture_existing: existing, shop_verified: true }));
