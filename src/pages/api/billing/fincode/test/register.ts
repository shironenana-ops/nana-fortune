import type { APIRoute } from "astro";
import { handleFincodeTestRegistration } from "../../../../../server/fincode/test/fincodeTestHttpHandlers";

export const prerender = false;

export const POST: APIRoute = ({ request }) => handleFincodeTestRegistration(request, import.meta.env);
export const ALL: APIRoute = ({ request }) => handleFincodeTestRegistration(request, import.meta.env);
