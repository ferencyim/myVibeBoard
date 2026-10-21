import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";

interface PaseoVivoPushModule {
  isAvailable(): boolean;
  register(): Promise<string | null>;
  consumePendingClick(): string | null;
}

// The native module is always linked on Android; it reports unavailable unless the build was made
// with the vivo SDK (plugins/with-vivo-push.js), so builds without the SDK never use vivo.
const vivoModule = requireOptionalNativeModule<PaseoVivoPushModule>("PaseoVivoPush");

export function isVivoPushAvailable(): boolean {
  if (!vivoModule || Constants.expoConfig?.extra?.vivoPush !== true) return false;
  try {
    return vivoModule.isAvailable();
  } catch {
    return false;
  }
}

/** Turns vivo push on and returns the regId, or null when none was issued. */
export async function registerVivoPush(): Promise<string | null> {
  if (!vivoModule) return null;
  const regId = await vivoModule.register();
  return regId?.trim() || null;
}

/** Custom data of the notification the user tapped while the app was closed or in the background. */
export function consumeVivoNotificationClick(): Record<string, unknown> | null {
  if (!vivoModule) return null;
  try {
    const raw = vivoModule.consumePendingClick();
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
