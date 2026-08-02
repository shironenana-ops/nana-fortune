import type { APIRoute } from "astro";
import { handleFincodeTestResult } from "../../../server/fincode/test/fincodeTestHttpHandlers";

export const prerender = false;

export const GET: APIRoute = ({ request }) => handleFincodeTestResult(request, import.meta.env);
export const POST: APIRoute = ({ request }) => handleFincodeTestResult(request, import.meta.env);
export const ALL: APIRoute = ({ request }) => handleFincodeTestResult(request, import.meta.env);
