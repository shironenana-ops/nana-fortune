import type { ShironeReadingSection } from "../../../lib/shironeEngine";
import { READING_PROSE_SCHEMA_VERSION, type ReadingProseInvalidOutputDetail, type RenderableReadingMode } from "./readingProseRenderer";

const MAX_RAW_OUTPUT = 100_000;
const MAX_BODY: Record<RenderableReadingMode, number> = { light: 8_000, deep: 20_000 };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class ReadingProseValidationError extends Error {
  constructor(public readonly code: string, public readonly detail: ReadingProseInvalidOutputDetail) {
    super(code);
    this.name = "ReadingProseValidationError";
  }
}

export function validateReadingProseOutput(params: {
  text: string;
  mode: RenderableReadingMode;
  canonicalSections: ReadonlyArray<ShironeReadingSection>;
}): ShironeReadingSection[] {
  if (!params.text || params.text.length > MAX_RAW_OUTPUT) throw new ReadingProseValidationError("OUTPUT_SIZE_INVALID", "body_constraints");
  if (/```/u.test(params.text)) throw new ReadingProseValidationError("CODE_FENCE_NOT_ALLOWED", "json_parse");
  let value: unknown;
  try { value = JSON.parse(params.text); } catch { throw new ReadingProseValidationError("OUTPUT_JSON_INVALID", "json_parse"); }
  return validateReadingProseValueInternal({ value, mode: params.mode, canonicalSections: params.canonicalSections, allowLegacyArray: true });
}

export function validateReadingProseValue(params: {
  value: unknown;
  mode: RenderableReadingMode;
  canonicalSections: ReadonlyArray<ShironeReadingSection>;
}): ShironeReadingSection[] {
  return validateReadingProseValueInternal({ ...params, allowLegacyArray: false });
}

function validateReadingProseValueInternal(params: {
  value: unknown;
  mode: RenderableReadingMode;
  canonicalSections: ReadonlyArray<ShironeReadingSection>;
  allowLegacyArray: boolean;
}): ShironeReadingSection[] {
  const value = params.value;
  if (!record(value) || Object.keys(value).some((key) => !["schema_version", "sections"].includes(key))) {
    throw new ReadingProseValidationError("OUTPUT_SCHEMA_INVALID", "section_shape");
  }
  if (value.schema_version !== READING_PROSE_SCHEMA_VERSION) {
    throw new ReadingProseValidationError("OUTPUT_SCHEMA_INVALID", "schema_version");
  }
  if (record(value.sections)) {
    const sectionObject = value.sections;
    const canonicalIds = params.canonicalSections.map(({ id }) => id);
    const actualIds = Object.keys(sectionObject);
    if (actualIds.length !== canonicalIds.length || actualIds.some((id) => !canonicalIds.includes(id))) {
      throw new ReadingProseValidationError("SECTION_SET_INVALID", "section_set");
    }
    return params.canonicalSections.map((canonical) => {
      const rawBody = sectionObject[canonical.id];
      if (typeof rawBody !== "string") throw new ReadingProseValidationError("SECTION_BODY_INVALID", "body_constraints");
      const body = rawBody.replace(/\r\n?/gu, "\n").trim();
      if (!body || body.length > MAX_BODY[params.mode] || CONTROL.test(body)) throw new ReadingProseValidationError("SECTION_BODY_INVALID", "body_constraints");
      return { ...canonical, body };
    });
  }
  if (!params.allowLegacyArray || !Array.isArray(value.sections)) throw new ReadingProseValidationError("OUTPUT_SCHEMA_INVALID", "section_shape");
  if (value.sections.length !== params.canonicalSections.length) throw new ReadingProseValidationError("SECTION_COUNT_INVALID", "section_set");
  const seen = new Set<string>();
  return value.sections.map((raw, index) => {
    if (!record(raw) || Object.keys(raw).some((key) => !["id", "body"].includes(key))) throw new ReadingProseValidationError("SECTION_SCHEMA_INVALID", "section_shape");
    const canonical = params.canonicalSections[index];
    if (typeof raw.id !== "string" || seen.has(raw.id)) throw new ReadingProseValidationError("SECTION_ID_INVALID", "section_set");
    if (raw.id !== canonical.id) throw new ReadingProseValidationError("SECTION_ID_INVALID", "section_order");
    seen.add(raw.id);
    if (typeof raw.body !== "string") throw new ReadingProseValidationError("SECTION_BODY_INVALID", "body_constraints");
    const body = raw.body.replace(/\r\n?/gu, "\n").trim();
    if (!body || body.length > MAX_BODY[params.mode] || CONTROL.test(body)) throw new ReadingProseValidationError("SECTION_BODY_INVALID", "body_constraints");
    return { ...canonical, body };
  });
}
