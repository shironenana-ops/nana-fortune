// Legacy billing UI compatibility shim.
// 本番決済は開通させず、申込条件の確認導線だけを提供する。
const BILLING_PREPARATION_MESSAGE =
  "本番カード決済は現在準備中です。\n申込内容確認ページをご確認ください。";

function findMessageBox() {
  return document.getElementById("billingMessage") || document.getElementById("joinBillingMessage");
}

function showBillingPreparationMessage() {
  const box = findMessageBox();
  if (box) {
    box.textContent = BILLING_PREPARATION_MESSAGE;
    box.style.display = "block";
  }
}

function getPreparationButtonLabel(button) {
  const plan = button?.getAttribute("data-checkout-plan") || "";
  if (plan === "extra") return "音声単体はプラン案内へ";
  if (plan === "normal" || plan === "light") return "ライト会員はプラン案内へ";
  if (plan === "premium") return "プレミアム会員はプラン案内へ";
  return "プラン案内へ";
}

function prepareBillingButton(button) {
  if (!button) return;
  button.textContent = getPreparationButtonLabel(button);
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("title", "料金・申込条件はプラン案内ページからご確認ください");
  button.classList.add("is-billing-disabled");
}

function prepareBillingButtons(selector = "[data-checkout-plan]") {
  document.querySelectorAll(selector).forEach(prepareBillingButton);
}

async function startCheckout() {
  showBillingPreparationMessage();
}

function bindBillingButtons() {
  document.querySelectorAll("[data-checkout-plan]").forEach((button) => {
    prepareBillingButton(button);
    if (button.dataset.billingBound === "true") return;
    button.dataset.billingBound = "true";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showBillingPreparationMessage();
    });
  });
}

window.startCheckout = startCheckout;
window.bindBillingButtons = bindBillingButtons;
window.ShironeBilling = {
  startCheckout,
  bindBillingButtons,
  isBillingDisabled: () => true,
  prepareBillingButton,
  prepareBillingButtons,
  showBillingPreparationMessage,
  getBillingPreparationInlineMessage: () => BILLING_PREPARATION_MESSAGE,
};
