import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";

if (!process.argv.includes("--execute-staging-test")) throw new Error("EXPLICIT_STAGING_TEST_FLAG_REQUIRED");
if (process.env.AWS_PROFILE !== "shirone-staging" || process.env.AWS_REGION !== "ap-northeast-1") throw new Error("STAGING_AWS_BOUNDARY_INVALID");

function envFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const env = envFile(await readFile(".env.local", "utf8"));
if (env.FINCODE_TEST_API_BASE !== "https://api.test.fincode.jp" || !env.FINCODE_TEST_SECRET_KEY?.startsWith("m_test_") || !/^[A-Za-z0-9_-]{1,60}$/u.test(env.FINCODE_TEST_SHOP_ID ?? "")) throw new Error("FINCODE_TEST_BOUNDARY_INVALID");
const response = await fetch("https://api.test.fincode.jp/v1/plans", { headers: { authorization: `Bearer ${env.FINCODE_TEST_SECRET_KEY}`, accept: "application/json" }, redirect: "manual" });
if (!response.ok) throw new Error("FINCODE_TEST_PLAN_LIST_FAILED");
const body = await response.json();
const list = Array.isArray(body?.list) ? body.list : [];
const matching = (amount) => list.filter((plan) => plan && Number(plan.amount) === amount && Number(plan.tax) === 0 && plan.interval_pattern === "month" && Number(plan.interval_count) === 1 && plan.delete_flag !== "1");
const light = matching(980); const premium = matching(2980);
if (light.length !== 1 || premium.length !== 1 || typeof light[0].id !== "string" || typeof premium[0].id !== "string") throw new Error("FINCODE_TEST_PLAN_CONTRACT_INVALID");

const secretName = "shirone7/staging/fincode/test-provider";
const client = new SecretsManagerClient({ region: "ap-northeast-1", maxAttempts: 1 });
let secretArn;
try {
  secretArn = (await client.send(new DescribeSecretCommand({ SecretId: secretName }))).ARN;
} catch (error) {
  if (error?.name !== "ResourceNotFoundException") throw new Error("STAGING_TEST_SECRET_LOOKUP_FAILED");
  secretArn = (await client.send(new CreateSecretCommand({
    Name: secretName,
    Description: "Temporary staging-only fincode TEST provider credential",
    SecretString: JSON.stringify({ fincode_test_secret_key: env.FINCODE_TEST_SECRET_KEY, fincode_test_shop_id: env.FINCODE_TEST_SHOP_ID }),
    Tags: [{ Key: "Project", Value: "nana-fortune" }, { Key: "Environment", Value: "staging" }, { Key: "Purpose", Value: "fincode-test-e2e" }],
  }))).ARN;
}
if (typeof secretArn !== "string") throw new Error("STAGING_TEST_SECRET_INVALID");
const outputPath = join(tmpdir(), `nana-fincode-test-contract-${randomUUID()}.json`);
await writeFile(outputPath, JSON.stringify({ planMapping: JSON.stringify({ [light[0].id]: "light", [premium[0].id]: "premium" }), secretArn }), { encoding: "utf8", mode: 0o600 });
process.stdout.write(JSON.stringify({ prepared: true, lightPlanCount: 1, premiumPlanCount: 1, secretReady: true, outputPath }) + "\n");
