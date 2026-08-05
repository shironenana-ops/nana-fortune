import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  FINCODE_ONE_TIME_VOICE_PRODUCT,
  type FincodeOneTimeVoiceAtomicGrantPort,
  type FincodeOneTimeVoicePurchaseIntent,
  type FincodeOneTimeVoicePurchaseIntentPort,
} from "../oneTimeVoicePurchase";

type Sender = { send(command: unknown): Promise<unknown> };
type DiagnosticCode = "VOICE_DDB_TRANSACTION_CANCELED" | "VOICE_DDB_VALIDATION" | "VOICE_DDB_ACCESS_DENIED" | "VOICE_DDB_THROTTLED" | "VOICE_DDB_UNAVAILABLE";
type Item = Record<string, AttributeValue>;
const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const readS = (item: Item | undefined, key: string): string | undefined => {
  const value = item?.[key];
  return value && "S" in value ? value.S : undefined;
};
const readN = (item: Item | undefined, key: string): number | undefined => {
  const value = item?.[key];
  const raw = value && "N" in value ? value.N : undefined;
  return typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : undefined;
};

function transactionConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "TransactionCanceledException";
}

export type FincodeOneTimeVoiceDynamoConfig = {
  purchaseTableName: string;
  usersTableName: string;
  environment: "test" | "staging";
};

function validConfig(config: FincodeOneTimeVoiceDynamoConfig): boolean {
  return /^[A-Za-z0-9_.-]{3,255}$/u.test(config.purchaseTableName)
    && /^[A-Za-z0-9_.-]{3,255}$/u.test(config.usersTableName)
    && (config.environment === "test" || config.environment === "staging");
}

export class DynamoFincodeOneTimeVoicePurchaseStore
  implements FincodeOneTimeVoicePurchaseIntentPort, FincodeOneTimeVoiceAtomicGrantPort {
  constructor(
    private readonly client: Sender,
    private readonly config: FincodeOneTimeVoiceDynamoConfig,
    private readonly diagnosticSink?: (code: DiagnosticCode) => void,
  ) {}

  async createRegistered(input: FincodeOneTimeVoicePurchaseIntent): Promise<"CREATED" | "CONFLICT" | "UNAVAILABLE"> {
    if (!validConfig(this.config) || input.environment !== this.config.environment || input.state !== "REGISTERED") return "UNAVAILABLE";
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.config.purchaseTableName,
        Item: {
          payment_digest: s(input.paymentDigest), payload_fingerprint: s(input.payloadFingerprint), user_reference: s(input.userReference),
          environment: s(input.environment), shop_digest: s(input.shopDigest), product: s(input.product), amount: n(input.amount),
          processing_state: s(input.state), schema_version: s("shirone-fincode-one-time-voice-v1"), version: n(1),
        },
        ConditionExpression: "attribute_not_exists(payment_digest)",
      }));
      return "CREATED";
    } catch (error) {
      return transactionConflict(error) || (error as { name?: unknown })?.name === "ConditionalCheckFailedException" ? "CONFLICT" : "UNAVAILABLE";
    }
  }

  async findByPaymentDigest(paymentDigest: string): Promise<FincodeOneTimeVoicePurchaseIntent | null> {
    if (!validConfig(this.config)) throw new Error("FINCODE_ONE_TIME_VOICE_CONFIG_INVALID");
    const result = await this.client.send(new GetItemCommand({
      TableName: this.config.purchaseTableName, Key: { payment_digest: s(paymentDigest) }, ConsistentRead: true,
      ProjectionExpression: "payment_digest, payload_fingerprint, user_reference, environment, shop_digest, product, amount, processing_state",
    })) as { Item?: Item };
    const item = result.Item;
    const environment = readS(item, "environment");
    const state = readS(item, "processing_state");
    if (!item || (environment !== "test" && environment !== "staging") || (state !== "REGISTERED" && state !== "COMPLETED")) return null;
    const amount = readN(item, "amount");
    if (amount !== 300 || readS(item, "product") !== FINCODE_ONE_TIME_VOICE_PRODUCT) return null;
    const payment = readS(item, "payment_digest");
    const fingerprint = readS(item, "payload_fingerprint");
    const user = readS(item, "user_reference");
    const shop = readS(item, "shop_digest");
    if (!payment || !fingerprint || !user || !shop) return null;
    return { paymentDigest: payment, payloadFingerprint: fingerprint, userReference: user, environment, shopDigest: shop, product: FINCODE_ONE_TIME_VOICE_PRODUCT, amount: 300, state };
  }

  async grant(input: { purchase: FincodeOneTimeVoicePurchaseIntent; completedAt: string }): Promise<"COMPLETED" | "ALREADY_COMPLETED" | "RETRYABLE_FAILURE"> {
    if (!validConfig(this.config) || input.purchase.environment !== this.config.environment || input.purchase.state !== "REGISTERED") return "RETRYABLE_FAILURE";
    try {
      await this.client.send(new TransactWriteItemsCommand({
        TransactItems: [
          { Update: {
            TableName: this.config.purchaseTableName, Key: { payment_digest: s(input.purchase.paymentDigest) },
            UpdateExpression: "SET processing_state = :completed, completed_at = :completedAt, updated_at = :completedAt ADD version :one",
            ConditionExpression: "processing_state = :registered AND payload_fingerprint = :fingerprint AND environment = :environment AND product = :product AND amount = :amount",
            ExpressionAttributeValues: {
              ":completed": s("COMPLETED"), ":registered": s("REGISTERED"), ":completedAt": s(input.completedAt), ":one": n(1),
              ":fingerprint": s(input.purchase.payloadFingerprint), ":environment": s(input.purchase.environment), ":product": s(FINCODE_ONE_TIME_VOICE_PRODUCT), ":amount": n(300),
            },
          } },
          { Update: {
            TableName: this.config.usersTableName, Key: { user_id: s(input.purchase.userReference) },
            UpdateExpression: "ADD extra_voice_remaining :one SET updated_at = :updatedAt",
            ConditionExpression: "attribute_exists(user_id)",
            ExpressionAttributeValues: { ":one": n(1), ":updatedAt": s(input.completedAt) },
          } },
        ],
      }));
      return "COMPLETED";
    } catch (error) {
      if (!transactionConflict(error)) {
        const name = (error as { name?: unknown })?.name;
        this.diagnosticSink?.(
          name === "ValidationException" ? "VOICE_DDB_VALIDATION" :
            name === "AccessDeniedException" ? "VOICE_DDB_ACCESS_DENIED" :
              name === "ThrottlingException" || name === "ProvisionedThroughputExceededException" ? "VOICE_DDB_THROTTLED" :
                "VOICE_DDB_UNAVAILABLE",
        );
        return "RETRYABLE_FAILURE";
      }
      this.diagnosticSink?.("VOICE_DDB_TRANSACTION_CANCELED");
      try {
        const stored = await this.findByPaymentDigest(input.purchase.paymentDigest);
        return stored?.state === "COMPLETED" && stored.payloadFingerprint === input.purchase.payloadFingerprint
          ? "ALREADY_COMPLETED"
          : "RETRYABLE_FAILURE";
      } catch {
        return "RETRYABLE_FAILURE";
      }
    }
  }
}
