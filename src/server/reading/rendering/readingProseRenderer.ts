import type { ShironeEngineResult, ShironeReadingSection } from "../../../lib/shironeEngine";

export const READING_PROSE_SCHEMA_VERSION = "shirone-reading-prose-v1" as const;
export const READING_PROSE_PROMPT_VERSION = "shirone-reading-prose-prompt-v2" as const;

export type RenderableReadingMode = "light" | "deep";

export type ReadingProseCanonicalInput = {
  mode: RenderableReadingMode;
  displayName: string;
  question?: string;
  title: string;
  todayMessage: string;
  marginMessage: string;
  oneStep: string;
  avoidHint: string;
  sections: ReadonlyArray<Pick<ShironeReadingSection, "id" | "title" | "summary" | "body">>;
};

export type ReadingProseProviderResult = {
  output: unknown;
  provider: string;
  modelAlias?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export interface ReadingProseRenderer {
  render(input: ReadingProseCanonicalInput, options?: { signal?: AbortSignal }): Promise<ReadingProseProviderResult>;
}

export type RenderedReading = ShironeEngineResult & {
  rendering: {
    status: "canonical" | "rendered" | "fallback";
    provider: "canonical" | "bedrock";
    promptVersion?: string;
    errorCode?: string;
    fallbackReason?: ReadingProseFallbackReason;
    invalidOutputDetail?: ReadingProseInvalidOutputDetail;
  };
};

export type ReadingProseFallbackReason =
  | "timeout"
  | "provider_error"
  | "invalid_output"
  | "configuration_error";

export type ReadingProseInvalidOutputDetail =
  | "json_parse"
  | "schema_version"
  | "section_shape"
  | "section_set"
  | "section_order"
  | "body_constraints"
  | "stop_reason"
  | "tool_missing"
  | "tool_count"
  | "tool_name"
  | "tool_input"
  | "unknown";

export function createCanonicalProseInput(params: {
  displayName: string;
  question?: string;
  reading: ShironeEngineResult;
}): ReadingProseCanonicalInput {
  if (params.reading.plan !== "light" && params.reading.plan !== "deep") {
    throw new TypeError("Only light and deep readings can be rendered");
  }
  return {
    mode: params.reading.plan,
    displayName: params.displayName.trim(),
    ...(params.question?.trim() ? { question: params.question.trim() } : {}),
    title: params.reading.title,
    todayMessage: params.reading.todayMessage,
    marginMessage: params.reading.marginMessage,
    oneStep: params.reading.oneStep,
    avoidHint: params.reading.avoidHint,
    sections: params.reading.sections.map(({ id, title, summary, body }) => ({ id, title, summary, body })),
  };
}
