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
