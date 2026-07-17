import { ServerFoundationError } from "../http/errors";

export type ReadingPersistenceConfig = { idempotencyTable: string; historyTable: string; hashSecret: string; leaseSeconds: number; ttlSeconds: number };
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new ServerFoundationError("PERSISTENCE_NOT_CONFIGURED");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ServerFoundationError("PERSISTENCE_NOT_CONFIGURED");
  return number;
}
export function readReadingPersistenceConfig(env: Record<string, string | undefined> = process.env): ReadingPersistenceConfig {
  const idempotencyTable = env.READING_IDEMPOTENCY_TABLE_NAME ?? "";
  const historyTable = env.READING_HISTORY_TABLE_NAME ?? "";
  const hashSecret = env.READING_IDEMPOTENCY_HASH_SECRET ?? "";
  if (!idempotencyTable || !historyTable || hashSecret.length < 32) throw new ServerFoundationError("PERSISTENCE_NOT_CONFIGURED");
  return {
    idempotencyTable, historyTable, hashSecret,
    leaseSeconds: integer(env.READING_IDEMPOTENCY_LEASE_SECONDS, 120, 90, 900),
    ttlSeconds: integer(env.READING_IDEMPOTENCY_TTL_SECONDS, 604800, 3600, 2592000),
  };
}
