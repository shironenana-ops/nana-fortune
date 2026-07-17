export type MoshPlanId = "free" | "light" | "premium" | "voice_single";
export type MoshBillingType = "free" | "subscription" | "one_time";

export type MoshPlan = {
  id: MoshPlanId;
  displayName: string;
  billingType: MoshBillingType;
  price: number;
  priceLabel: string;
  description: string;
  features: readonly string[];
  moshUrl: string | null;
  external: boolean;
};

const MOSH_HOST = "mosh.jp";

export const MOSH_PLANS: Readonly<Record<MoshPlanId, MoshPlan>> = {
  free: {
    id: "free",
    displayName: "無料プラン",
    billingType: "free",
    price: 0,
    priceLabel: "0円",
    description: "登録不要の属性鑑定や今日の鑑定を無料で利用できます。",
    features: ["TOP属性鑑定", "今日の鑑定", "属性一覧", "相性占い"],
    moshUrl: null,
    external: false,
  },
  light: {
    id: "light",
    displayName: "ライト会員",
    billingType: "subscription",
    price: 980,
    priceLabel: "月額980円",
    description: "無料機能に加えて、ライト鑑定を新しく作れる月額プランです。",
    features: ["無料機能", "ライト鑑定", "鑑定履歴の保存・閲覧"],
    moshUrl: "https://mosh.jp/services/385958?openExternalBrowser=1",
    external: true,
  },
  premium: {
    id: "premium",
    displayName: "プレミアム会員",
    billingType: "subscription",
    price: 2980,
    priceLabel: "月額2,980円",
    description: "ライト鑑定と深掘り鑑定、会員向け音声利用権を含む月額プランです。",
    features: ["無料・ライト鑑定", "深掘り鑑定", "会員向け音声利用権", "鑑定履歴の保存・閲覧"],
    moshUrl: "https://mosh.jp/services/385965?openExternalBrowser=1",
    external: true,
  },
  voice_single: {
    id: "voice_single",
    displayName: "音声単体買い切り",
    billingType: "one_time",
    price: 300,
    priceLabel: "300円・買い切り",
    description: "MOSHでの購入確認後、音声鑑定1回分を個別に反映する商品です。",
    features: ["音声鑑定1回分", "月額契約なし", "購入確認後に一度だけ反映"],
    moshUrl: "https://mosh.jp/services/385969?openExternalBrowser=1",
    external: true,
  },
};

export function isMoshBillingEnabled(value: unknown): boolean {
  return value === "true";
}

export function getSafeMoshUrl(plan: MoshPlan): string | null {
  if (!plan.external || !plan.moshUrl) return null;

  try {
    const url = new URL(plan.moshUrl);
    if (url.protocol !== "https:" || url.hostname !== MOSH_HOST) return null;
    if (!/^\/services\/\d+$/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function canApplyForMoshPlan(plan: MoshPlan, billingEnabled: boolean): boolean {
  return billingEnabled && Boolean(getSafeMoshUrl(plan));
}
