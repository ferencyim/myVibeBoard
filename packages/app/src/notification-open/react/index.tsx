import { useEffect } from "react";
import { router, usePathname, useRootNavigationState, type Href } from "expo-router";
import { useHostRegistryStatus } from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useIsLastWorkspaceSelectionHydrated,
} from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useToast } from "@/contexts/toast-api-context";
import { isRetiredVibePush, resolveVibePushRoute } from "@/vibe/sessions/push-route";
import { createNotificationOpenRouter, parseNotificationOpenTarget } from "../model";
import { createNotificationOpenSource, type NotificationTap } from "../source";

let ready = false;
let forkTapHandler: ((tap: NotificationTap) => boolean) | null = null;
const waiters = new Set<() => void>();
const notificationRouter = createNotificationOpenRouter({
  source: createNotificationOpenSource(),
  openAgent: (target) => navigateToAgent({ ...target, pin: true }),
  openTerminal: ({ serverId, workspaceId, terminalId }) =>
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "terminal", terminalId },
    }),
  openRoute: (route) => router.navigate(route as Href),
  whenReadyToNavigate: () =>
    ready
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.add(resolve);
        }),
  openForkTap: (tap) => forkTapHandler?.(tap) ?? false,
});

export function NotificationOpenRouter({ startupBlocked }: { startupBlocked: boolean }) {
  const root = useRootNavigationState();
  const pathname = usePathname();
  const registryStatus = useHostRegistryStatus();
  const selectionHydrated = useIsLastWorkspaceSelectionHydrated();
  const toast = useToast();
  // Index routes redirect during startup. Let their final leaf commit before dispatching a tap.
  const atStartupIndex = pathname === "/" || /^\/h\/[^/]+\/?$/.test(pathname);
  const canNavigate = Boolean(
    root?.key &&
    registryStatus === "ready" &&
    selectionHydrated &&
    !startupBlocked &&
    !atStartupIndex,
  );
  useEffect(() => {
    forkTapHandler = (tap) => {
      if (isRetiredVibePush(tap.data)) {
        toast.show("旧看板入口已停用，请从项目的工作区打开任务");
        return true;
      }
      if (parseNotificationOpenTarget(tap.data)?.kind !== "host") return false;
      const route = resolveVibePushRoute(tap.data);
      if (!route) return false;
      router.navigate(route as Href);
      return true;
    };
    return () => {
      forkTapHandler = null;
    };
  }, [toast]);
  useEffect(() => {
    ready = canNavigate;
    if (ready) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
    return () => {
      ready = false;
    };
  }, [canNavigate]);
  useEffect(() => notificationRouter.start(), []);
  return null;
}
