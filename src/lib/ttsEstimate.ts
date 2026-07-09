import {
  VOICE_MAX_AUTO_SECONDS,
  VOICE_MAX_AUTO_SLOTS,
  VOICE_SLOT_SECONDS,
  calculateRequiredVoiceSlots,
  isAutoVoiceGenerationAllowed
} from "./voiceUsageTypes";

export const TTS_ESTIMATE_CHARS_PER_MINUTE = 300;
export const TTS_ESTIMATE_MIN_CHARS_PER_MINUTE = 50;
export const TTS_ESTIMATE_MAX_CHARS_PER_MINUTE = 1000;
export const TTS_ESTIMATE_MAX_TEXT_LENGTH = 50000;

export type TtsEstimateInput = {
  text: string;
  charsPerMinute?: unknown;
};

export type TtsEstimateResult = {
  textLength: number;
  estimatedDurationSec: number;
  requiredSlots: number;
  slotSeconds: number;
  maxAutoSeconds: number;
  maxAutoSlots: number;
  autoGenerationAllowed: boolean;
  charsPerMinute: number;
};

export function normalizeTtsEstimateText(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t\r\n\u3000]+/g, " ")
    .trim();
}

export function normalizeTtsCharsPerMinute(charsPerMinute: unknown): number {
  const numericValue = Number(charsPerMinute);

  if (
    !Number.isFinite(numericValue) ||
    numericValue < TTS_ESTIMATE_MIN_CHARS_PER_MINUTE ||
    numericValue > TTS_ESTIMATE_MAX_CHARS_PER_MINUTE
  ) {
    return TTS_ESTIMATE_CHARS_PER_MINUTE;
  }

  return numericValue;
}

export function estimateTtsDurationSec(
  text: string,
  charsPerMinute = TTS_ESTIMATE_CHARS_PER_MINUTE
): number {
  const normalized = normalizeTtsEstimateText(text);

  if (!normalized) {
    return 0;
  }

  const safeCharsPerMinute = normalizeTtsCharsPerMinute(charsPerMinute);

  // This is a lightweight estimate. string.length is intentionally used as a
  // rough character count; surrogate pairs, emoji, and combining marks may not
  // match the user's perceived character count.
  return Math.ceil((normalized.length / safeCharsPerMinute) * 60);
}

export function createTtsEstimate(input: TtsEstimateInput): TtsEstimateResult {
  const normalized = normalizeTtsEstimateText(input.text);
  const charsPerMinute = normalizeTtsCharsPerMinute(input.charsPerMinute);
  const estimatedDurationSec = estimateTtsDurationSec(normalized, charsPerMinute);
  const requiredSlots = calculateRequiredVoiceSlots(estimatedDurationSec);

  return {
    textLength: normalized.length,
    estimatedDurationSec,
    requiredSlots,
    slotSeconds: VOICE_SLOT_SECONDS,
    maxAutoSeconds: VOICE_MAX_AUTO_SECONDS,
    maxAutoSlots: VOICE_MAX_AUTO_SLOTS,
    autoGenerationAllowed: isAutoVoiceGenerationAllowed(estimatedDurationSec),
    charsPerMinute
  };
}
