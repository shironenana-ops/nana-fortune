import type { ShironeEngineResult, ShironeReadingSection } from "../../lib/shironeEngine";
import type { HeaderMap } from "../auth/sessionToken";
import type { AuditEvent } from "../audit/safeAuditLog";
import type { Clock } from "../reading/serverReadingDate";
import type { RenderedReading } from "../reading/rendering/readingProseRenderer";
import type { UserRepository } from "../users/userRepository";
import type { ReadingPersistence } from "../readingPersistence/readingPersistence";

export const READING_API_PATH = "/reading/generate";
export const READING_BODY_MAX_BYTES = 16 * 1024;
export const READING_ENCODED_BODY_MAX_BYTES = 24 * 1024;

export type ApiGatewayV2Event = {
  version?: unknown;
  rawPath?: unknown;
  headers?: unknown;
  body?: unknown;
  isBase64Encoded?: unknown;
  requestContext?: unknown;
};

export type LambdaHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
};

export type ReadingApiRequest = {
  requestId: string;
  headers: HeaderMap;
  rawBody: unknown;
};

export type PublicReadingSection = Pick<ShironeReadingSection, "id" | "body"> & { heading: string };
export type PublicReadingResponse = {
  request_id: string;
  resolved_mode: "free" | "light" | "deep";
  status: "completed";
  rendering_status: "canonical" | "rendered" | "fallback";
  result: {
    title: string;
    sections: PublicReadingSection[];
    one_step: string;
    avoid_hint: string;
  };
};

export type ReadingApiDependencies = {
  repository: UserRepository;
  clock: Clock;
  sessionSecret?: string;
  auditHashSecret?: string;
  auditSink?: (line: string) => void;
  engineRunner: (input: Parameters<typeof import("../shironeEngineServer").runShironeEngineOnServer>[0]) => ShironeEngineResult;
  renderReading: (params: {
    requestId: string;
    displayName: string;
    question?: string;
    reading: ShironeEngineResult;
  }) => Promise<RenderedReading>;
  audit?: (event: AuditEvent, userId?: string) => void;
  persistence: ReadingPersistence;
  idempotencyHashSecret?: string;
  deepEnabled: boolean;
};
