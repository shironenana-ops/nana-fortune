// Legacy billing UI compatibility shim.
// MOSH導線は /join だけで管理する。旧Checkout APIへは接続しない。
const BILLING_PREPARATION_MESSAGE =
  "この画面からのお申し込みは現在利用できません。\nプラン案内ページをご確認ください。";

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
  button.setAttribute("title", "MOSH申込みはプラン案内ページからご確認ください");
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
