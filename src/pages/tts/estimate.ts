import type { APIRoute } from "astro";
import {
  TTS_ESTIMATE_MAX_TEXT_LENGTH,
  createTtsEstimate,
  normalizeTtsEstimateText
} from "../../lib/ttsEstimate";

export const prerender = false;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...headers
    }
  });
}

function methodNotAllowed() {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
      message: "POSTでリクエストしてください。"
    },
    405,
    {
      Allow: "POST"
    }
  );
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_json",
        message: "JSON形式のリクエストを送信してください。"
      },
      400
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_json",
        message: "JSON形式のリクエストを送信してください。"
      },
      400
    );
  }

  const payload = body as Record<string, unknown>;
  const text = payload.text;

  if (typeof text !== "string" || !normalizeTtsEstimateText(text)) {
    return jsonResponse(
      {
        ok: false,
        error: "text_required",
        message: "見積もり対象の本文を指定してください。"
      },
      400
    );
  }

  const normalizedText = normalizeTtsEstimateText(text);

  if (normalizedText.length > TTS_ESTIMATE_MAX_TEXT_LENGTH) {
    return jsonResponse(
      {
        ok: false,
        error: "text_too_long",
        message: "見積もり対象の本文が長すぎます。"
      },
      413
    );
  }

  const estimate = createTtsEstimate({
    text: normalizedText,
    charsPerMinute: payload.chars_per_minute ?? payload.charsPerMinute
  });

  return jsonResponse({
    ok: true,
    kind: "tts_audio_estimate",
    text_length: estimate.textLength,
    estimated_duration_sec: estimate.estimatedDurationSec,
    required_slots: estimate.requiredSlots,
    slot_seconds: estimate.slotSeconds,
    max_auto_seconds: estimate.maxAutoSeconds,
    max_auto_slots: estimate.maxAutoSlots,
    auto_generation_allowed: estimate.autoGenerationAllowed,
    chars_per_minute: estimate.charsPerMinute
  });
};

export const GET: APIRoute = methodNotAllowed;
export const PUT: APIRoute = methodNotAllowed;
export const PATCH: APIRoute = methodNotAllowed;
export const DELETE: APIRoute = methodNotAllowed;
export const OPTIONS: APIRoute = methodNotAllowed;
