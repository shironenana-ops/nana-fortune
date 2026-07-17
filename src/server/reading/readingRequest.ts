import type { ReadingMode } from "../../lib/readingModeResolution";
import { ServerFoundationError } from "../http/errors";

export type ValidatedReadingRequest = {
  name: string;
  birthDate: string;
  question?: string;
  requestedMode?: ReadingMode;
};

const ALLOWED_FIELDS = new Set(["name", "birth_date", "question", "requested_mode"]);
const READING_MODES = new Set<ReadingMode>(["free", "light", "deep"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateReadingRequest(input: unknown, serverToday: string): ValidatedReadingRequest {
  if (!isPlainRecord(input)) throw new ServerFoundationError("READING_REQUEST_INVALID");
  if (!isRealIsoDate(serverToday)) throw new TypeError("serverToday must be YYYY-MM-DD");
  if (Object.keys(input).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new ServerFoundationError("READING_REQUEST_INVALID");
  }

  if (typeof input.name !== "string") throw new ServerFoundationError("READING_REQUEST_INVALID");
  const name = input.name.trim();
  if (!name || CONTROL_CHARACTERS.test(name)) {
    throw new ServerFoundationError("READING_REQUEST_INVALID");
  }
  if (codePointLength(name) > 80) throw new ServerFoundationError("READING_INPUT_TOO_LONG");

  if (typeof input.birth_date !== "string" || !isRealIsoDate(input.birth_date)) {
    throw new ServerFoundationError("READING_BIRTH_DATE_INVALID");
  }
  if (input.birth_date < "1900-01-01" || input.birth_date > serverToday) {
    throw new ServerFoundationError("READING_BIRTH_DATE_INVALID");
  }

  let question: string | undefined;
  if (input.question !== undefined) {
    if (typeof input.question !== "string" || input.question.includes("\0")) {
      throw new ServerFoundationError("READING_REQUEST_INVALID");
    }
    question = input.question.trim() || undefined;
    if (question && codePointLength(question) > 2_000) {
      throw new ServerFoundationError("READING_INPUT_TOO_LONG");
    }
  }

  let requestedMode: ReadingMode | undefined;
  if (input.requested_mode !== undefined) {
    if (typeof input.requested_mode !== "string" || !READING_MODES.has(input.requested_mode as ReadingMode)) {
      throw new ServerFoundationError("READING_MODE_INVALID");
    }
    requestedMode = input.requested_mode as ReadingMode;
  }

  return {
    name,
    birthDate: input.birth_date,
    ...(question ? { question } : {}),
    ...(requestedMode ? { requestedMode } : {}),
  };
}
