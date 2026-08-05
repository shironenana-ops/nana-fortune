import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ServerFoundationError } from "../http/errors";

type SecretSender = { send(command: GetSecretValueCommand): Promise<{ SecretString?: string }> };

const ARN_PATTERN = /^arn:aws:secretsmanager:ap-northeast-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/u;
const TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u;

export function assertStagingTableName(value: unknown): string {
  if (
    typeof value !== "string"
    || !TABLE_PATTERN.test(value)
    || !/staging/iu.test(value)
    || /prod|production/iu.test(value)
  ) {
    throw new ServerFoundationError("STAGING_AUTH_NOT_CONFIGURED");
  }
  return value;
}

export function assertStagingRuntimeSecretArn(value: unknown): string {
  if (typeof value !== "string" || !ARN_PATTERN.test(value) || /prod/iu.test(value)) {
    throw new ServerFoundationError("STAGING_AUTH_NOT_CONFIGURED");
  }
  return value;
}

export async function loadStagingSessionSecret(input: {
  secretArn: string;
  client?: SecretSender;
}): Promise<string> {
  const secretArn = assertStagingRuntimeSecretArn(input.secretArn);
  try {
    const client = input.client ?? new SecretsManagerClient({ region: "ap-northeast-1" });
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = JSON.parse(response.SecretString ?? "") as unknown;
    const secret = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).session_token_secret
      : undefined;
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("invalid secret contract");
    }
    return secret;
  } catch (error) {
    if (error instanceof ServerFoundationError) throw error;
    throw new ServerFoundationError("STAGING_AUTH_NOT_CONFIGURED", { cause: error });
  }
}
