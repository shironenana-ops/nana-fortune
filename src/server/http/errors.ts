export type ServerErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID_SCHEME"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_EXPIRED"
  | "AUTH_INVALID_PAYLOAD"
  | "AUTH_NOT_CONFIGURED"
  | "USER_NOT_FOUND"
  | "USERS_TABLE_NOT_CONFIGURED"
  | "USER_STORE_UNAVAILABLE"
  | "ORIGIN_NOT_ALLOWED"
  | "CORS_NOT_CONFIGURED"
  | "AUDIT_NOT_CONFIGURED"
  | "READING_REQUEST_INVALID"
  | "READING_INPUT_TOO_LONG"
  | "READING_BIRTH_DATE_INVALID"
  | "READING_MODE_INVALID"
  | "READING_MODE_NOT_AVAILABLE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_INVALID"
  | "HTTP_EVENT_INVALID"
  | "HTTP_ROUTE_NOT_FOUND"
  | "HTTP_METHOD_NOT_ALLOWED"
  | "READING_API_DISABLED"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "REQUEST_BODY_TOO_LARGE"
  | "REQUEST_BODY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "PERSISTENCE_NOT_CONFIGURED"
  | "PERSISTENCE_UNAVAILABLE"
  | "HISTORY_UNAVAILABLE"
  | "READING_DEEP_DISABLED"
  | "READING_DEEP_NOT_ENTITLED"
  | "READING_DEEP_MONTHLY_LIMIT_REACHED"
  | "READING_DEEP_QUOTA_CONFIG_ERROR"
  | "READING_DEEP_QUOTA_UNAVAILABLE"
  | "READING_DEEP_RESERVATION_INCONSISTENT"
  | "INTERNAL_ERROR";

const DEFINITIONS: Record<ServerErrorCode, { status: number; message: string }> = {
  AUTH_MISSING: { status: 401, message: "認証情報を確認してください" },
  AUTH_INVALID_SCHEME: { status: 401, message: "認証情報を確認してください" },
  AUTH_INVALID_TOKEN: { status: 401, message: "認証情報を確認してください" },
  AUTH_EXPIRED: { status: 401, message: "認証情報を確認してください" },
  AUTH_INVALID_PAYLOAD: { status: 401, message: "認証情報を確認してください" },
  AUTH_NOT_CONFIGURED: { status: 500, message: "サーバー設定を確認しています" },
  USER_NOT_FOUND: { status: 404, message: "利用者情報が見つかりません" },
  USERS_TABLE_NOT_CONFIGURED: { status: 500, message: "サーバー設定を確認しています" },
  USER_STORE_UNAVAILABLE: { status: 503, message: "現在、利用者情報を確認できません" },
  ORIGIN_NOT_ALLOWED: { status: 403, message: "この接続元からは利用できません" },
  CORS_NOT_CONFIGURED: { status: 500, message: "サーバー設定を確認しています" },
  AUDIT_NOT_CONFIGURED: { status: 500, message: "サーバー設定を確認しています" },
  READING_REQUEST_INVALID: { status: 400, message: "鑑定の入力内容を確認してください" },
  READING_INPUT_TOO_LONG: { status: 400, message: "鑑定の入力内容が長すぎます" },
  READING_BIRTH_DATE_INVALID: { status: 400, message: "生年月日を確認してください" },
  READING_MODE_INVALID: { status: 400, message: "鑑定モードを確認してください" },
  READING_MODE_NOT_AVAILABLE: { status: 403, message: "この鑑定モードは現在利用できません" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: "リクエストキーが必要です" },
  IDEMPOTENCY_KEY_INVALID: { status: 400, message: "リクエストキーを確認してください" },
  HTTP_EVENT_INVALID: { status: 400, message: "リクエスト形式を確認してください" },
  HTTP_ROUTE_NOT_FOUND: { status: 404, message: "指定された操作が見つかりません" },
  HTTP_METHOD_NOT_ALLOWED: { status: 405, message: "この操作方法は利用できません" },
  READING_API_DISABLED: { status: 503, message: "この鑑定機能は現在利用できません" },
  CONTENT_TYPE_NOT_SUPPORTED: { status: 415, message: "JSON形式で送信してください" },
  REQUEST_BODY_TOO_LARGE: { status: 413, message: "送信内容が大きすぎます" },
  REQUEST_BODY_INVALID: { status: 400, message: "送信内容を確認してください" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "同じリクエストキーを別の内容には使用できません" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "この鑑定は現在処理中です" },
  PERSISTENCE_NOT_CONFIGURED: { status: 500, message: "サーバー設定を確認しています" },
  PERSISTENCE_UNAVAILABLE: { status: 503, message: "現在、鑑定結果を確定できません" },
  HISTORY_UNAVAILABLE: { status: 503, message: "保存済みの鑑定結果を確認できません" },
  READING_DEEP_DISABLED: { status: 403, message: "深掘り鑑定は現在利用できません" },
  READING_DEEP_NOT_ENTITLED: { status: 403, message: "この鑑定モードは現在利用できません" },
  READING_DEEP_MONTHLY_LIMIT_REACHED: { status: 403, message: "今月の深読み鑑定の利用回数に達しています" },
  READING_DEEP_QUOTA_CONFIG_ERROR: { status: 500, message: "現在この鑑定を利用できません" },
  READING_DEEP_QUOTA_UNAVAILABLE: { status: 503, message: "現在この鑑定を利用できません" },
  READING_DEEP_RESERVATION_INCONSISTENT: { status: 503, message: "現在この鑑定を利用できません" },
  INTERNAL_ERROR: { status: 500, message: "処理を完了できませんでした" },
};

export class ServerFoundationError extends Error {
  constructor(public readonly code: ServerErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "ServerFoundationError";
  }
}

export function toSafeErrorResponse(error: unknown, requestId: string) {
  const code = error instanceof ServerFoundationError ? error.code : "INTERNAL_ERROR";
  const definition = DEFINITIONS[code];
  return {
    status: definition.status,
    body: {
      error: { code, message: definition.message, request_id: requestId },
    },
  };
}
