const BILLING_DISABLED = true;
const BILLING_API_URL = "https://zaebx82pyf.execute-api.ap-northeast-1.amazonaws.com/checkout";
const BILLING_PREPARATION_MESSAGE =
  "このお申し込みの扉は、現在静かに準備中です。\n正式なご案内まで、今しばらくお待ちください。\n料金が発生することはありません。";
const BILLING_PREPARATION_INLINE_MESSAGE =
  "特別な鑑定への扉は、現在準備中です。\nすべての準備が整いましたら、内容と価格を確認できる形でご案内します。";

function getCanonicalUserId() {
  return localStorage.getItem("user_id") || localStorage.getItem("userId") || "";
}

function getLoginEmail() {
  return (
    localStorage.getItem("loginEmail") ||
    localStorage.getItem("userEmail") ||
    localStorage.getItem("user_email") ||
    ""
  );
}

function getToken() {
  return localStorage.getItem("token") || "";
}

function showBillingMessage(message, isError = false) {
  const box = document.getElementById("billingMessage") || document.getElementById("joinBillingMessage");
  if (!box) return;

  box.textContent = message;
  box.style.display = "block";
  box.style.color = isError ? "#ffb3b3" : "#f5e8bf";
  box.style.borderColor = isError
    ? "rgba(255, 120, 120, 0.45)"
    : "rgba(202, 168, 79, 0.35)";
  box.style.background = isError
    ? "rgba(80, 12, 18, 0.35)"
    : "rgba(202, 168, 79, 0.08)";
}

function showBillingPreparationMessage() {
  showBillingMessage(BILLING_PREPARATION_INLINE_MESSAGE, false);
  alert(BILLING_PREPARATION_MESSAGE);
}

function getPreparationButtonLabel(button) {
  const plan = button.getAttribute("data-checkout-plan") || button.getAttribute("data-plan") || "";
  const currentLabel = (button.textContent || "").trim();

  if (currentLabel.includes("変更")) return "プラン変更（準備中）";
  if (plan === "extra") return "単発音声（準備中）";
  if (plan === "normal" || plan === "light") return "ライト会員（準備中）";
  if (plan === "premium") return "Premium（準備中）";
  return "準備中";
}

function prepareBillingButton(button) {
  if (!BILLING_DISABLED || !button) return;

  if (!button.dataset.billingOriginalLabel) {
    button.dataset.billingOriginalLabel = (button.textContent || "").trim();
  }

  button.textContent = getPreparationButtonLabel(button);
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("title", "お申し込みの扉は現在準備中です");
  button.classList.add("is-billing-disabled");
  button.removeAttribute("disabled");
}

function prepareBillingButtons(selector = "[data-checkout-plan]") {
  document.querySelectorAll(selector).forEach((button) => {
    prepareBillingButton(button);
  });
}

function isBillingDisabled() {
  return BILLING_DISABLED;
}

function getBillingPreparationInlineMessage() {
  return BILLING_PREPARATION_INLINE_MESSAGE;
}

async function startCheckout(arg1, arg2 = location.pathname) {
  if (BILLING_DISABLED) {
    showBillingPreparationMessage();
    return;
  }

  let plan = "";
  let sourcePath = location.pathname;
  let userId = "";
  let email = "";
  if (typeof arg1 === "object" && arg1 !== null) {
    plan = arg1.plan || "";
    sourcePath = arg1.source_path || location.pathname;
    userId = arg1.user_id || getCanonicalUserId();
    email = arg1.email || getLoginEmail();
  } else {
    plan = arg1 || "";
    sourcePath = arg2 || location.pathname;
    userId = getCanonicalUserId();
    email = getLoginEmail();
  }

  const token = getToken();

  if (!token || !email) {
    alert("ログイン後にお申し込みください。");
    window.location.href = `/login?redirect=${encodeURIComponent(location.pathname)}`;
    return;
  }

  if (!userId) {
    alert("user_id が見つかりません。ログインし直してください。");
    return;
  }

  if (!plan) {
    alert("プラン情報が見つかりません。");
    return;
  }

  showBillingMessage("決済画面へ接続しています...");

  try {
    const response = await fetch(BILLING_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id: userId,
        email,
        plan,
        source_path: sourcePath
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error || data?.message || "Checkout API error");
    }

    if (!data?.url) {
      throw new Error("Stripe Checkout URL が返ってきませんでした。");
    }

    window.location.href = data.url;
  } catch (error) {
    console.error("checkout error:", error);
    showBillingMessage("申込み画面を開けませんでした。\n少し時間を置いて、もう一度お試しください。", true);
    throw error;
  }
}

function bindBillingButtons() {
  const buttons = document.querySelectorAll("[data-checkout-plan]");
  buttons.forEach((button) => {
    prepareBillingButton(button);

    if (button.dataset.billingBound === "true") return;
    button.dataset.billingBound = "true";

    button.addEventListener("click", async (event) => {
      if (BILLING_DISABLED) {
        event.preventDefault();
        showBillingPreparationMessage();
        return;
      }

      const plan = button.getAttribute("data-checkout-plan");
      const sourcePath = button.getAttribute("data-source-path") || location.pathname;
      await startCheckout(plan, sourcePath);
    });
  });
}

window.startCheckout = startCheckout;
window.bindBillingButtons = bindBillingButtons;
window.ShironeBilling = {
  startCheckout,
  bindBillingButtons,
  isBillingDisabled,
  prepareBillingButton,
  prepareBillingButtons,
  showBillingPreparationMessage,
  getBillingPreparationInlineMessage
};
