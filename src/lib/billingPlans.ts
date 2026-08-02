export type BillingPlanId = "free" | "light" | "premium" | "voice_single";
export type BillingType = "free" | "subscription" | "one_time";

export type BillingPlan = {
  id: BillingPlanId;
  displayName: string;
  billingType: BillingType;
  price: number;
  priceLabel: string;
  description: string;
  features: readonly string[];
  lightMonthlyLimit: number;
  deepMonthlyLimit: number;
  voiceMonthlyLimit: number;
  voiceSingleUnits: number;
  provider: "fincode" | null;
};

export const BILLING_PLANS: Readonly<Record<BillingPlanId, BillingPlan>> = {
  free: {
    id: "free",
    displayName: "無料",
    billingType: "free",
    price: 0,
    priceLabel: "0円",
    description: "登録不要で、白音七の無料範囲の鑑定を利用できます。",
    features: ["今日の占い", "属性診断", "相性占い", "無料範囲の鑑定"],
    lightMonthlyLimit: 0,
    deepMonthlyLimit: 0,
    voiceMonthlyLimit: 0,
    voiceSingleUnits: 0,
    provider: null,
  },
  light: {
    id: "light",
    displayName: "ライト会員",
    billingType: "subscription",
    price: 980,
    priceLabel: "月額980円（税込）",
    description: "無料機能に加え、ライト鑑定と音声枠を利用できる月額プランです。",
    features: ["無料機能", "ライト鑑定 月5回", "音声 月3枠", "鑑定履歴の保存・閲覧"],
    lightMonthlyLimit: 5,
    deepMonthlyLimit: 0,
    voiceMonthlyLimit: 3,
    voiceSingleUnits: 0,
    provider: "fincode",
  },
  premium: {
    id: "premium",
    displayName: "プレミアム会員",
    billingType: "subscription",
    price: 2980,
    priceLabel: "月額2,980円（税込）",
    description: "ライト鑑定、深掘り鑑定、音声枠を利用できる月額プランです。",
    features: ["無料機能", "ライト鑑定 月20回", "深掘り鑑定 月3回", "音声 月10枠", "鑑定履歴の保存・閲覧"],
    lightMonthlyLimit: 20,
    deepMonthlyLimit: 3,
    voiceMonthlyLimit: 10,
    voiceSingleUnits: 0,
    provider: "fincode",
  },
  voice_single: {
    id: "voice_single",
    displayName: "音声鑑定1回分",
    billingType: "one_time",
    price: 300,
    priceLabel: "300円（税込）・買い切り",
    description: "月額契約なしで、音声鑑定1回分の利用権を追加する商品です。",
    features: ["音声鑑定1回分", "月額契約なし", "買い切り"],
    lightMonthlyLimit: 0,
    deepMonthlyLimit: 0,
    voiceMonthlyLimit: 0,
    voiceSingleUnits: 1,
    provider: "fincode",
  },
};

export const PAID_BILLING_PLAN_IDS = ["light", "premium", "voice_single"] as const;
export type PaidBillingPlanId = typeof PAID_BILLING_PLAN_IDS[number];

export function isBillingPlanId(value: unknown): value is BillingPlanId {
  return typeof value === "string" && Object.hasOwn(BILLING_PLANS, value);
}

export function isPaidBillingPlanId(value: unknown): value is PaidBillingPlanId {
  return typeof value === "string" && (PAID_BILLING_PLAN_IDS as readonly string[]).includes(value);
}

export function getBillingPlan(value: unknown): BillingPlan | null {
  return isBillingPlanId(value) ? BILLING_PLANS[value] : null;
}

export function getPaidBillingPlan(value: unknown): BillingPlan | null {
  return isPaidBillingPlanId(value) ? BILLING_PLANS[value] : null;
}

export function getCheckoutHref(planId: PaidBillingPlanId): string {
  return `/checkout?plan=${encodeURIComponent(planId)}`;
}

export function isFincodeCheckoutEnabled(value: unknown): boolean {
  return value === "true";
}

export function isFincodeTestCheckoutEnabled(input: {
  enabled: unknown;
  planId: unknown;
  publicKey: unknown;
}): boolean {
  return input.enabled === "true"
    && input.planId === "voice_single"
    && typeof input.publicKey === "string"
    && input.publicKey.startsWith("p_test_")
    && input.publicKey.length > "p_test_".length;
}
