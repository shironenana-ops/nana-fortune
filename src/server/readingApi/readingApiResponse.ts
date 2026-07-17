import type { RenderedReading } from "../reading/rendering/readingProseRenderer";
import type { PublicReadingResponse } from "./readingApiTypes";

export function toPublicReadingResponse(requestId: string, reading: RenderedReading): PublicReadingResponse {
  return {
    request_id: requestId,
    resolved_mode: reading.plan,
    status: "completed",
    rendering_status: reading.rendering.status,
    result: {
      title: reading.title,
      sections: reading.sections.map((section) => ({
        id: section.id,
        heading: section.title,
        body: section.body,
      })),
      one_step: reading.oneStep,
      avoid_hint: reading.avoidHint,
    },
  };
}
