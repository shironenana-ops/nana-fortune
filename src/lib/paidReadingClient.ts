export type PaidReadingMode = "light" | "deep";

export type PaidReadingInput = {
  name: string;
  birthDate: string;
  question?: string;
  mode: PaidReadingMode;
};

export type PaidReadingResult = {
  title: string;
  sections: Array<{ id: string; heading: string; body: string }>;
  oneStep: string;
  avoidHint: string;
};

export class PaidReadingClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PaidReadingClientError";
  }
}

function endpoint(value: string, route: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new PaidReadingClientError("READING_CONFIGURATION_ERROR"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.hostname.endsWith(".execute-api.ap-northeast-1.amazonaws.com") ||
      !new RegExp(`^/(production|staging)${route.replace("/", "\\/")}$`, "u").test(url.pathname)) {
    throw new PaidReadingClientError("READING_CONFIGURATION_ERROR");
  }
  return url;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new PaidReadingClientError("READING_RESPONSE_INVALID"); }
  if (!record(body)) throw new PaidReadingClientError("READING_RESPONSE_INVALID");
  if (!response.ok) {
    const error = record(body.error) && typeof body.error.code === "string" ? body.error.code : "READING_REQUEST_FAILED";
    throw new PaidReadingClientError(error);
  }
  return body;
}

function result(value: unknown): PaidReadingResult {
  if (!record(value) || typeof value.title !== "string" || !Array.isArray(value.sections) ||
      typeof value.one_step !== "string" || typeof value.avoid_hint !== "string") {
    throw new PaidReadingClientError("READING_RESPONSE_INVALID");
  }
  const sections = value.sections.map((section) => {
    if (!record(section) || typeof section.id !== "string" || typeof section.heading !== "string" || typeof section.body !== "string") {
      throw new PaidReadingClientError("READING_RESPONSE_INVALID");
    }
    return { id: section.id, heading: section.heading, body: section.body };
  });
  if (sections.length === 0) throw new PaidReadingClientError("READING_RESPONSE_INVALID");
  return { title: value.title, sections, oneStep: value.one_step, avoidHint: value.avoid_hint };
}

function completed(body: Record<string, unknown>): PaidReadingResult | null {
  if (body.status === "completed") return result(body.result);
  if (body.status === "COMPLETED" && record(body.reading)) return result(body.reading.result);
  return null;
}

export async function runPaidReading(input: {
  readingUrl: string;
  statusUrl: string;
  token: string;
  idempotencyKey: string;
  reading: PaidReadingInput;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  maxPolls?: number;
}): Promise<PaidReadingResult> {
  const readingUrl = endpoint(input.readingUrl, "/reading");
  const statusUrl = endpoint(input.statusUrl, "/reading/status");
  const readingStage = readingUrl.pathname.split("/")[1];
  const statusStage = statusUrl.pathname.split("/")[1];
  if (readingUrl.origin !== statusUrl.origin || readingStage !== statusStage || !input.token || input.token.length > 4096 ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(input.idempotencyKey)) throw new PaidReadingClientError("READING_CONFIGURATION_ERROR");
  const fetchImpl = input.fetchImpl ?? fetch;
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxPolls = input.maxPolls ?? 60;
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) throw new PaidReadingClientError("READING_CONFIGURATION_ERROR");

  const requestBody = {
    name: input.reading.name,
    birth_date: input.reading.birthDate,
    ...(input.reading.question ? { question: input.reading.question } : {}),
    requested_mode: input.reading.mode,
  };
  const accepted = await json(await fetchImpl(readingUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json; charset=utf-8", "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify(requestBody),
    credentials: "omit",
    redirect: "error",
  }));
  const immediate = completed(accepted);
  if (immediate) return immediate;
  if (accepted.status !== "queued" || typeof accepted.job_ref !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(accepted.job_ref)) {
    throw new PaidReadingClientError("READING_RESPONSE_INVALID");
  }

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (attempt > 0) await wait(3_000);
    const url = new URL(statusUrl);
    url.searchParams.set("job_ref", accepted.job_ref);
    const status = await json(await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.token}` },
      credentials: "omit",
      redirect: "error",
    }));
    const done = completed(status);
    if (done) return done;
    if (status.status === "FAILED") throw new PaidReadingClientError("READING_JOB_FAILED");
    if (status.status !== "QUEUED" && status.status !== "IN_PROGRESS") throw new PaidReadingClientError("READING_RESPONSE_INVALID");
  }
  throw new PaidReadingClientError("READING_POLL_TIMEOUT");
}
