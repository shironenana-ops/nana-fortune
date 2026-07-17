import type { ShironeEngineResult } from "../../../lib/shironeEngine";
import { writeSafeAuditLog } from "../../audit/safeAuditLog";
import { buildReadingProsePrompt } from "./readingProsePrompt";
import { validateReadingProseValue, ReadingProseValidationError } from "./readingProseOutput";
import { BedrockReadingOutputError } from "./bedrockReadingProseRenderer";
import { createCanonicalProseInput, type ReadingProseFallbackReason, type ReadingProseRenderer, type RenderedReading } from "./readingProseRenderer";

type Options = {
  renderer?: ReadingProseRenderer;
  enabled: boolean;
  requestId: string;
  displayName: string;
  question?: string;
  reading: ShironeEngineResult;
  auditSink?: (line: string) => void;
  now?: () => number;
};

function canonical(reading: ShironeEngineResult): RenderedReading {
  return { ...reading, rendering: { status: "canonical", provider: "canonical" } };
}

function fallbackReason(error: unknown): ReadingProseFallbackReason {
  if (error instanceof ReadingProseValidationError) return "invalid_output";
  if (error instanceof BedrockReadingOutputError) return "invalid_output";
  if (error instanceof Error && (error.name === "TimeoutError" || error.message === "BEDROCK_TIMEOUT")) return "timeout";
  return "provider_error";
}

export async function renderReadingWithFallback(options: Options): Promise<RenderedReading> {
  if (options.reading.plan === "free" || !options.enabled || !options.renderer) return canonical(options.reading);
  const started = (options.now ?? Date.now)();
  const input = createCanonicalProseInput({ displayName: options.displayName, question: options.question, reading: options.reading });
  const promptVersion = buildReadingProsePrompt(input).promptVersion;
  const audit = (event: string, outcome: "success" | "error", extra: Record<string, unknown> = {}) => writeSafeAuditLog({
    event: { requestId: options.requestId, event, outcome, resolvedMode: input.mode, provider: "bedrock", promptVersion,
      durationMs: Math.max(0, (options.now ?? Date.now)() - started), ...extra },
    sink: options.auditSink,
  });
  audit("reading_render_started", "success", { inputCharacters: JSON.stringify(input).length });
  try {
    const provider = await options.renderer.render(input);
    const sections = validateReadingProseValue({ value: provider.output, mode: input.mode, canonicalSections: options.reading.sections });
    audit("reading_render_succeeded", "success", { inputTokens: provider.inputTokens, outputTokens: provider.outputTokens });
    return { ...options.reading, sections, rendering: { status: "rendered", provider: "bedrock", promptVersion } };
  } catch (error) {
    const errorCode = error instanceof ReadingProseValidationError ? error.code : "PROVIDER_ERROR";
    const reason = fallbackReason(error);
    const invalidOutputDetail = error instanceof ReadingProseValidationError || error instanceof BedrockReadingOutputError
      ? error.detail
      : undefined;
    audit("reading_render_failed", "error", { errorCode });
    audit("reading_render_fallback", "success", { errorCode });
    return { ...options.reading, rendering: { status: "fallback", provider: "canonical", promptVersion, errorCode, fallbackReason: reason, ...(invalidOutputDetail ? { invalidOutputDetail } : {}) } };
  }
}
