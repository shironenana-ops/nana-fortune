import type {
  NormalizedFincodeSubscriptionEvent,
  FincodeTransitionResult,
} from "./webhookTypes";

export function decideFincodeSubscriptionTransition(
  event: NormalizedFincodeSubscriptionEvent,
): FincodeTransitionResult {
  switch (event.status) {
    case "ACTIVE":
      return event.eventType === "subscription.card.regist"
        ? { decision: "ACTIVATE_SUBSCRIPTION", mutationAllowed: false, reasonCode: "ACTIVE_REGISTRATION" }
        : { decision: "UPDATE_SUBSCRIPTION", mutationAllowed: false, reasonCode: "ACTIVE_SUBSCRIPTION" };
    case "RUNNING":
      return { decision: "UPDATE_SUBSCRIPTION", mutationAllowed: false, reasonCode: "SUBSCRIPTION_RUNNING" };
    case "CANCELED":
      return { decision: "CANCEL_SUBSCRIPTION", mutationAllowed: false, reasonCode: "SUBSCRIPTION_CANCELED" };
    case "INCOMPLETE":
      return { decision: "RECORD_INCOMPLETE", mutationAllowed: false, reasonCode: "SUBSCRIPTION_INCOMPLETE" };
  }
}
