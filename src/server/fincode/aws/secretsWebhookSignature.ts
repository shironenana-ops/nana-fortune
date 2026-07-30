import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { FincodeWebhookAwsError } from "./webhookAwsErrors";

type Sender = { send(command: unknown): Promise<unknown> };
const SECRET_KEY = "fincode_webhook_signature";

function parseSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE");
  let secret = value;
  if (value.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !(SECRET_KEY in parsed)) {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE");
    }
    secret = (parsed as Record<string, unknown>)[SECRET_KEY] as string;
  }
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 4096 || /[\r\n\0]/u.test(secret)) {
    throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE");
  }
  return secret;
}

export class SecretsManagerFincodeWebhookSignature {
  private cached?: { value: string; expiresAt: number };

  constructor(
    private readonly client: Sender,
    private readonly secretId: string,
    private readonly cacheTtlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  async getExpectedSignature(): Promise<string> {
    const current = this.now();
    if (this.cached && current < this.cached.expiresAt) return this.cached.value;
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId })) as {
        SecretString?: unknown; SecretBinary?: unknown;
      };
      if (result.SecretBinary !== undefined) throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE");
      const value = parseSecret(result.SecretString);
      this.cached = { value, expiresAt: current + this.cacheTtlSeconds * 1000 };
      return value;
    } catch {
      throw new FincodeWebhookAwsError("FINCODE_WEBHOOK_SECRET_UNAVAILABLE");
    }
  }

  clear(): void { this.cached = undefined; }
}
