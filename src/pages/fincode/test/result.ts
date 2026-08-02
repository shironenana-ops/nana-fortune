import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";
import { handleFincodeTestResult } from "../../../server/fincode/test/fincodeTestHttpHandlers";

export const prerender = false;

const testEnvironment = {
  FINCODE_TEST_PAYMENT_ENABLED: getSecret("FINCODE_TEST_PAYMENT_ENABLED"),
  FINCODE_TEST_API_BASE: getSecret("FINCODE_TEST_API_BASE"),
  FINCODE_TEST_SECRET_KEY: getSecret("FINCODE_TEST_SECRET_KEY"),
  FINCODE_TEST_SHOP_ID: getSecret("FINCODE_TEST_SHOP_ID"),
};

export const GET: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment);
export const POST: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment);
export const ALL: APIRoute = ({ request }) => handleFincodeTestResult(request, testEnvironment);
