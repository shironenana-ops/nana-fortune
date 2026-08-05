import { createFincodePeriodId, validateFincodeSubscriptionPeriodInput, type FincodeSubscriptionPeriodSource } from "./subscriptionPeriodSource";

type FetchLike = typeof fetch;

export type ProvisionalFincodeTestProviderConfig = {
  apiOrigin: "https://api.test.fincode.jp";
  secretKey: string;
  shopId: string;
};

const PROVIDER_DATETIME = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u;
const SAFE_REF = /^[A-Za-z0-9_-]{1,60}$/u;

function provisionalTokyoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = PROVIDER_DATETIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +s, +ms));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(utc);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  if (get("year") !== y || get("month") !== mo || get("day") !== d || get("hour") !== h || get("minute") !== mi || get("second") !== s) return null;
  return utc.toISOString();
}

function exactConfig(config: ProvisionalFincodeTestProviderConfig): boolean {
  return config.apiOrigin === "https://api.test.fincode.jp" && config.secretKey.startsWith("m_test_") && SAFE_REF.test(config.shopId);
}

export class ProvisionalFincodeTestAsiaTokyoPeriodSource implements FincodeSubscriptionPeriodSource {
  constructor(private readonly config: ProvisionalFincodeTestProviderConfig, private readonly fetchImpl: FetchLike = fetch) {}

  async resolve(input: Parameters<FincodeSubscriptionPeriodSource["resolve"]>[0]) {
    if (!validateFincodeSubscriptionPeriodInput(input) || input.environment !== "staging" || !exactConfig(this.config)) return { status: "UNAVAILABLE" as const };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const url = new URL(`/v1/subscriptions/${encodeURIComponent(input.subscriptionReference)}?pay_type=Card`, this.config.apiOrigin);
      if (url.origin !== this.config.apiOrigin || url.hostname !== "api.test.fincode.jp") return { status: "CONFLICT" as const };
      const response = await this.fetchImpl(url, {
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${this.config.secretKey}` },
      });
      if (!response.ok) return response.status >= 500 ? { status: "UNAVAILABLE" as const } : { status: "NOT_AVAILABLE" as const };
      const body = await response.json() as Record<string, unknown>;
      if (body.id !== input.subscriptionReference || body.customer_id !== input.customerReference || body.plan_id !== input.planReference || body.pay_type !== "Card") return { status: "CONFLICT" as const };
      if (body.status !== "ACTIVE" && body.status !== "RUNNING") return { status: "NOT_AVAILABLE" as const };
      const periodStart = provisionalTokyoInstant(body.start_date);
      const periodEnd = provisionalTokyoInstant(body.next_charge_date);
      if (!periodStart || !periodEnd) return { status: "CONFLICT" as const };
      // Before the first scheduled charge fincode TEST can expose next_charge_date
      // equal to start_date. No contract period exists yet, so retry without guessing.
      if (Date.parse(periodStart) === Date.parse(periodEnd)) return { status: "NOT_AVAILABLE" as const };
      if (Date.parse(periodStart) > Date.parse(periodEnd)) return { status: "CONFLICT" as const };
      return {
        status: "RESOLVED" as const,
        periodId: createFincodePeriodId(periodStart, periodEnd), periodStart, periodEnd,
        source: "PROVISIONAL_FINCODE_TEST_ASIA_TOKYO" as const,
        sourceVersion: "fincode-test-provisional-asia-tokyo-v1",
      };
    } catch {
      return { status: "UNAVAILABLE" as const };
    } finally {
      clearTimeout(timer);
    }
  }
}
