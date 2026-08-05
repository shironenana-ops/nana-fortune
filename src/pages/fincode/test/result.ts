import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { handleFincodeTestResult } from "../../../server/fincode/test/fincodeTestHttpHandlers";
import { DynamoFincodeTestLightIntentStore } from "../../../server/fincode/test/fincodeTestLightDynamo";

export const prerender = false;

const testEnvironment = {
  FINCODE_TEST_PAYMENT_ENABLED: getSecret("FINCODE_TEST_PAYMENT_ENABLED"),
  FINCODE_TEST_API_BASE: getSecret("FINCODE_TEST_API_BASE"),
  FINCODE_TEST_SECRET_KEY: getSecret("FINCODE_TEST_SECRET_KEY"),
  FINCODE_TEST_SHOP_ID: getSecret("FINCODE_TEST_SHOP_ID"),
  FINCODE_TEST_BROWSER_E2E_PROFILE: getSecret("FINCODE_TEST_BROWSER_E2E_PROFILE"),
  FINCODE_TEST_LIGHT_START_DATE: getSecret("FINCODE_TEST_LIGHT_START_DATE"),
  PUBLIC_RUNTIME_ENV: import.meta.env.PUBLIC_RUNTIME_ENV,
  PUBLIC_STAGING_AUTH_ENABLED: import.meta.env.PUBLIC_STAGING_AUTH_ENABLED,
  PUBLIC_STAGING_API_BASE_URL: import.meta.env.PUBLIC_STAGING_API_BASE_URL,
  PUBLIC_FINCODE_TEST_BROWSER_E2E_PROFILE: import.meta.env.PUBLIC_FINCODE_TEST_BROWSER_E2E_PROFILE,
};

function lightStore(): DynamoFincodeTestLightIntentStore | undefined {
  if (getSecret("FINCODE_TEST_BROWSER_E2E_PROFILE") !== "light-browser-e2e") return undefined;
  const region = getSecret("FINCODE_TEST_AWS_REGION");
  const tableName = getSecret("FINCODE_TEST_CUSTOMER_MAPPING_TABLE");
  if (region !== "ap-northeast-1" || !tableName || /prod|production/iu.test(tableName)) return undefined;
  return new DynamoFincodeTestLightIntentStore(new DynamoDBClient({ region }), tableName);
}

export const GET: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment, undefined, lightStore());
export const POST: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment, undefined, lightStore());
export const ALL: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment, undefined, lightStore());
