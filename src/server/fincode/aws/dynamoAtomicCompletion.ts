import { createHash } from "node:crypto";
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import {
  isFincodeWebhookAtomicCompletionRequest,
  type FincodeWebhookAtomicCompletionPort,
  type FincodeWebhookAtomicCompletionRequest,
  type FincodeWebhookAtomicCompletionResult,
} from "../webhookPorts";
import {
  FINCODE_MEMBERSHIP_QUOTA_SCHEMA_VERSION,
  FINCODE_MEMBERSHIP_SCHEMA_VERSION,
  type FincodeWebhookAwsConfig,
} from "./webhookAwsConfig";

type Sender = { send(command: unknown): Promise<unknown> };
type Item = Record<string, AttributeValue>;
const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const b = (value: boolean): AttributeValue => ({ BOOL: value });
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const itemText = (item: Item | undefined, key: string) => item?.[key] && "S" in item[key] ? item[key].S : undefined;

function isTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const typed = error as { name?: unknown; CancellationReasons?: Array<{ Code?: unknown }> };
  return typed.name === "TransactionCanceledException" &&
    !!typed.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed");
}

function clientToken(input: FincodeWebhookAtomicCompletionRequest): string {
  return digest(`fincode-webhook-completion-v1\0${input.semanticEventKey}\0${input.payloadFingerprint}\0${input.completionPlan.resultCode}`).slice(0, 36);
}

export class DynamoFincodeAtomicCompletion implements FincodeWebhookAtomicCompletionPort {
  constructor(private readonly client: Sender, private readonly config: FincodeWebhookAwsConfig) {}

  private userMutation(input: FincodeWebhookAtomicCompletionRequest): TransactWriteItem | null {
    const plan = input.completionPlan;
    if (plan.ledgerOnly) return null;
    const names: Record<string, string> = {
      "#plan": "plan", "#status": "subscription_status", "#version": "membership_version",
      "#schema": "membership_schema_version", "#period": "membership_period_key",
    };
    const values: Record<string, AttributeValue> = {
      ":expectedVersion": n(plan.expectedMembership.version), ":nextVersion": n(plan.expectedMembership.version + 1),
      ":expectedPlan": s(plan.expectedMembership.plan), ":expectedStatus": s(plan.expectedMembership.subscriptionStatus),
      ":schema": s(FINCODE_MEMBERSHIP_SCHEMA_VERSION), ":event": s(input.semanticEventKey), ":now": s(input.completedAt),
    };
    const sets = ["#version = :nextVersion", "last_membership_event_digest = :event", "membership_updated_at = :now"];
    let condition = "attribute_exists(user_id) AND #schema = :schema AND #version = :expectedVersion AND #plan = :expectedPlan AND #status = :expectedStatus";
    if (plan.expectedMembership.periodKey === null) condition += " AND attribute_not_exists(#period)";
    else { condition += " AND #period = :expectedPeriod"; values[":expectedPeriod"] = s(plan.expectedMembership.periodKey); }

    if (plan.entitlementMutation.kind === "SET_MEMBERSHIP") {
      if (!plan.period) return null;
      Object.assign(names, {
        "#deep": "deep_enabled", "#voiceLimit": "monthly_voice_limit", "#cancel": "cancel_at_period_end",
        "#periodEnd": "membership_period_end",
      });
      Object.assign(values, {
        ":plan": s(plan.entitlementMutation.plan), ":status": s(plan.entitlementMutation.subscriptionStatus),
        ":deep": b(plan.entitlementMutation.deepEnabled), ":voiceLimit": n(plan.entitlementMutation.monthlyVoiceLimit),
        ":cancel": b(plan.entitlementMutation.cancelAtPeriodEnd), ":period": s(plan.period.periodKey), ":periodEnd": s(plan.period.periodEnd),
      });
      sets.push("#plan = :plan", "#status = :status", "#deep = :deep", "#voiceLimit = :voiceLimit", "#cancel = :cancel", "#period = :period", "#periodEnd = :periodEnd");
    } else if (plan.entitlementMutation.kind === "SET_CANCEL_AT_PERIOD_END") {
      names["#cancel"] = "cancel_at_period_end"; values[":cancel"] = b(true); sets.push("#cancel = :cancel");
    }
    if (plan.billingMutation.kind !== "NONE") {
      names["#billing"] = "membership_billing_state";
      values[":billing"] = s(plan.billingMutation.kind === "RECORD_INCOMPLETE" ? "INCOMPLETE" : "MANUAL_REVIEW");
      sets.push("#billing = :billing");
    }
    return { Update: {
      TableName: this.config.usersTableName, Key: { user_id: s(input.userReference) },
      UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    } };
  }

  private quotaMutation(input: FincodeWebhookAtomicCompletionRequest): TransactWriteItem | null {
    const mutation = input.completionPlan.quotaMutation;
    const period = input.completionPlan.period;
    if (mutation.kind !== "CREATE_PERIOD_ALLOWANCE") return null;
    if (!period || !this.config.lightQuotaTableName || mutation.preserveExistingUsage !== true) return null;
    const end = Date.parse(period.periodEnd);
    if (!Number.isFinite(end) || end <= Date.parse(input.completedAt)) return null;
    const quotaRef = digest(`fincode-light-quota-v1\0${input.userReference}\0${period.periodKey}\0light`);
    return { Update: {
      TableName: this.config.lightQuotaTableName,
      Key: { quota_ref: s(quotaRef) },
      UpdateExpression: "SET schema_version = :schema, period_key = :period, usage_type = :usage, #plan = :plan, #limit = :limit, used = if_not_exists(used, :zero), #version = if_not_exists(#version, :zero) + :one, created_at = if_not_exists(created_at, :now), updated_at = :now, expires_at = :expires",
      ConditionExpression: "attribute_not_exists(quota_ref) OR (schema_version = :schema AND period_key = :period AND usage_type = :usage)",
      ExpressionAttributeNames: { "#plan": "plan", "#limit": "limit", "#version": "version" },
      ExpressionAttributeValues: {
        ":schema": s(FINCODE_MEMBERSHIP_QUOTA_SCHEMA_VERSION), ":period": s(period.periodKey), ":usage": s("light"),
        ":plan": s(input.completionPlan.plan), ":limit": n(mutation.lightLimit), ":zero": n(0), ":one": n(1),
        ":now": s(input.completedAt), ":expires": n(Math.floor(end / 1000) + input.retentionTtlSeconds),
      },
    } };
  }

  private ledgerMutation(input: FincodeWebhookAtomicCompletionRequest): TransactWriteItem {
    return { Update: {
      TableName: this.config.ledgerTableName,
      Key: { event_digest: s(input.semanticEventKey) },
      UpdateExpression: "SET processing_state = :final, result_code = :result, correlation_digest = :correlation, mapped_user_digest = :user, completed_at = :completed, updated_at = :completed ADD version :one",
      ConditionExpression: "processing_state = :reserved AND payload_fingerprint = :fingerprint AND environment = :environment",
      ExpressionAttributeValues: {
        ":final": s(input.completionPlan.finalLedgerState), ":result": s(input.completionPlan.resultCode),
        ":correlation": s(input.correlationDigest), ":user": s(digest(`fincode-internal-user-v1\0${input.userReference}`)),
        ":completed": s(input.completedAt), ":one": n(1), ":reserved": s(input.expectedLedgerState),
        ":fingerprint": s(input.payloadFingerprint), ":environment": s(input.normalizedEvent.environment),
      },
    } };
  }

  private async recover(input: FincodeWebhookAtomicCompletionRequest): Promise<FincodeWebhookAtomicCompletionResult> {
    try {
      const result = await this.client.send(new GetItemCommand({
        TableName: this.config.ledgerTableName, Key: { event_digest: s(input.semanticEventKey) }, ConsistentRead: true,
        ProjectionExpression: "payload_fingerprint, processing_state, result_code",
      })) as { Item?: Item };
      if (itemText(result.Item, "payload_fingerprint") === input.payloadFingerprint &&
          ["COMPLETED", "MANUAL_REVIEW"].includes(itemText(result.Item, "processing_state") ?? "") &&
          itemText(result.Item, "result_code") === input.completionPlan.resultCode) return "ALREADY_COMPLETED";
    } catch { /* fixed retry result below */ }
    return "RETRYABLE_FAILURE";
  }

  async applyAndComplete(input: FincodeWebhookAtomicCompletionRequest): Promise<FincodeWebhookAtomicCompletionResult> {
    if (!this.config.mutationAvailable || !this.config.lightQuotaTableName ||
        this.config.usersMembershipSchemaVersion !== FINCODE_MEMBERSHIP_SCHEMA_VERSION ||
        !isFincodeWebhookAtomicCompletionRequest(input) || input.normalizedEvent.environment !== this.config.environment) return "UNAVAILABLE";
    const requiresPeriod = input.completionPlan.entitlementMutation.kind === "SET_MEMBERSHIP" ||
      input.completionPlan.quotaMutation.kind === "CREATE_PERIOD_ALLOWANCE";
    if (requiresPeriod && !input.completionPlan.period) return "UNAVAILABLE";
    const user = this.userMutation(input);
    const quota = this.quotaMutation(input);
    if (!input.completionPlan.ledgerOnly && !user) return "UNAVAILABLE";
    if (input.completionPlan.quotaMutation.kind !== "NONE" && !quota) return "UNAVAILABLE";
    const items = [user, quota, this.ledgerMutation(input)].filter((item): item is TransactWriteItem => !!item);
    if (items.length < 1 || items.length > 3) return "UNAVAILABLE";
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: clientToken(input) }));
      return "COMPLETED";
    } catch (error) {
      if (isTransactionConflict(error)) return "CONDITIONAL_CONFLICT";
      return this.recover(input);
    }
  }
}
