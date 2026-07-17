import { READING_PROSE_SCHEMA_VERSION, type ReadingProseCanonicalInput } from "./readingProseRenderer";

const BODY_LIMIT = { light: 8_000, deep: 20_000 } as const;

export function buildReadingProseJsonSchema(input: ReadingProseCanonicalInput): string {
  const sectionIds = input.sections.map(({ id }) => id);
  if (!sectionIds.length || new Set(sectionIds).size !== sectionIds.length) {
    throw new Error("BEDROCK_SCHEMA_INVALID");
  }
  const properties = Object.fromEntries(sectionIds.map((id) => [id, {
    type: "string",
    minLength: 1,
    maxLength: BODY_LIMIT[input.mode],
  }]));
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "sections"],
    properties: {
      schema_version: { const: READING_PROSE_SCHEMA_VERSION },
      sections: {
        type: "object",
        additionalProperties: false,
        required: sectionIds,
        properties,
      },
    },
  });
}
