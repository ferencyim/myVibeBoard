import { AppState } from "react-native";
import { revokeSubscription, startSubscription } from "./internal/subscriptions";
import { consumeVivoNotificationClick } from "./internal/vivo";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  return startSubscription(input);
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}

/**
 * vivo notifications are opened by the native receiver, which stores the tapped message's data.
 * Hand it to `onClick` at startup and whenever the app returns to the foreground.
 */
export function subscribeVivoNotificationClicks(
  onClick: (data: Record<string, unknown>) => void,
): () => void {
  const flush = () => {
    const data = consumeVivoNotificationClick();
    if (data) onClick(data);
  };
  flush();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") flush();
  });
  return () => subscription.remove();
}
