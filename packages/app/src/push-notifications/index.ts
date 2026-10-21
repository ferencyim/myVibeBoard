import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(_input: StartPushNotificationsInput): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: RevokePushNotificationsInput): Promise<void> {
  // Push notifications are native-only.
}

export function subscribeVivoNotificationClicks(
  _onClick: (data: Record<string, unknown>) => void,
): () => void {
  return () => undefined;
}
