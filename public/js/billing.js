const BILLING_DISABLED = true;
const BILLING_API_URL = "https://zaebx82pyf.execute-api.ap-northeast-1.amazonaws.com/checkout";

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
  const box = document.getElementById("billingMessage");
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

async function startCheckout(arg1, arg2 = location.pathname) {
  if (BILLING_DISABLED) {
    alert("β版では課金機能を停止しています。正式版で公開予定です。");
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
    showBillingMessage(`決済画面への接続に失敗しました: ${error.message}`, true);
    throw error;
  }
}

function bindBillingButtons() {
  const buttons = document.querySelectorAll("[data-checkout-plan]");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
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
  bindBillingButtons
};