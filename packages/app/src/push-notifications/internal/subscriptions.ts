import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { z } from "zod";
import { readValidatedString } from "@/storage/validated-storage";
import { isVivoPushAvailable, registerVivoPush } from "./vivo";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";

const STORAGE_PREFIX = "@paseo:expo-push-token:";
const ExpoPushTokenSchema = z.string().trim().min(1);

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function getExpoProjectId(): string | null {
  const fromEas = ExpoPushTokenSchema.safeParse(Constants.easConfig?.projectId);
  if (fromEas.success) return fromEas.data;
  const fromExtra = ExpoPushTokenSchema.safeParse(Constants.expoConfig?.extra?.eas?.projectId);
  return fromExtra.success ? fromExtra.data : null;
}

async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

interface ResolvedToken {
  token: string;
  channel: "fcm" | "vivo";
}

async function resolveToken(serverId: string): Promise<ResolvedToken | null> {
  const key = storageKey(serverId);
  const cached = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (!(await ensurePushPermission())) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  // Android: a native token delivered through the self-hosted push gateway. vivo phones with the
  // vivo SDK build use vivo push; everything else keeps the FCM token.
  if (Platform.OS === "android") {
    if (isVivoPushAvailable()) {
      const regId = await registerVivoPush().catch((error) => {
        console.warn("[PushNotifications] vivo registration failed, falling back to FCM", error);
        return null;
      });
      if (regId) {
        await AsyncStorage.setItem(key, regId);
        return { token: regId, channel: "vivo" };
      }
    }
    const native = await Notifications.getDevicePushTokenAsync();
    const nativeToken = typeof native.data === "string" ? native.data.trim() : "";
    if (!nativeToken)
      return cached && !isVivoPushAvailable() ? { token: cached, channel: "fcm" } : null;
    await AsyncStorage.setItem(key, nativeToken);
    return { token: nativeToken, channel: "fcm" };
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
    return cached ? { token: cached, channel: "fcm" } : null;
  }

  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = result.data.trim();
  if (!token) return cached ? { token: cached, channel: "fcm" } : null;
  await AsyncStorage.setItem(key, token);
  return { token, channel: "fcm" };
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  let token: ResolvedToken | null = null;
  const register = () => {
    if (stopped || !token || !input.client.isConnected) return;
    if (token.channel === "vivo") {
      // An older daemon would store the regId as an FCM token; only register with daemons that route by channel.
      if (input.client.getLastServerInfoMessage()?.features?.pushChannels !== true) return;
      input.client.registerPushToken(token.token, "vivo");
      return;
    }
    input.client.registerPushToken(token.token);
  };

  void resolveToken(input.serverId)
    .then((resolved) => {
      if (stopped) return undefined;
      token = resolved;
      register();
      return undefined;
    })
    .catch((error) => console.warn("[PushNotifications] Failed to register push token", error));

  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  const key = storageKey(input.serverId);
  const token = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (
    token &&
    input.client?.isConnected &&
    input.client.getLastServerInfoMessage()?.features?.pushTokenRevocation === true
  ) {
    try {
      await input.client.unregisterPushToken(token);
    } catch (error) {
      console.warn("[PushNotifications] Failed to revoke push token", error);
    }
  }
  await AsyncStorage.removeItem(key);
}
