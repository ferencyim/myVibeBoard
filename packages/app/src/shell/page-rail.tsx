import { router, usePathname } from "expo-router";
import { Bot, BookOpen, Clock3, CircleGauge, Settings } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { PluginIcon } from "@getpaseo/plugin/client";
import type { Theme } from "@/styles/theme";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { PAGE_RAIL_WIDTH } from "@/components/desktop-sidebar-layout";
import { PluginIconView } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "@/plugins/routes";
import { useOpenSidebarUsage } from "@/usage";
import { sortPageRailItems } from "./page-rail-model";
import { buildSettingsHostSectionRoute, buildSettingsRoute } from "@/utils/host-routes";

export function PageRail({
  horizontal = false,
  onNavigate,
}: {
  horizontal?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const openUsage = useOpenSidebarUsage();
  const hostId =
    (hostFilters.length === 1 ? hostFilters[0] : undefined) ??
    hostIdFromPathname(pathname) ??
    hosts[0]?.serverId;
  const grouped = new Map<string, (typeof plugins)[number]>();
  for (const plugin of plugins) {
    for (const item of plugin.pageRailItems ?? []) {
      const key = `${plugin.id}/${item.id}`;
      if (!grouped.has(key) || plugin.serverId === hostId) grouped.set(key, plugin);
    }
  }
  const entries = [...grouped.entries()].map(([key, plugin]) => {
    const item = plugin.pageRailItems!.find((entry) => `${plugin.id}/${entry.id}` === key)!;
    const route = buildPluginSurfaceRoute(plugin.serverId, plugin.id, {
      kind: "surface",
      id: item.screenId,
    });
    return {
      key,
      label: plugin.i18n.resolve(item.title, plugin.locale),
      icon: item.icon,
      order: item.order ?? 0,
      active: pathname === route,
      press: () => router.push(route),
    };
  });
  const builtin = [
    ...(!entries.some((entry) => entry.key === "vibe-master/master")
      ? [
          {
            key: "bot",
            label: "bot",
            icon: Bot,
            order: 0,
            active: pathname === "/sessions",
            press: () => router.push("/sessions"),
          },
        ]
      : []),
    {
      key: "routines",
      label: "例程",
      icon: Clock3,
      order: 10,
      active: pathname === "/routines",
      press: () => router.push("/routines" as never),
    },
    {
      key: "prompts",
      label: "提示词仓库",
      icon: BookOpen,
      order: 20,
      active: pathname.endsWith("/prompts"),
      press: () => {
        if (hostId) router.push(buildSettingsHostSectionRoute(hostId, "prompts"));
      },
    },
    { key: "usage", label: "用量", icon: CircleGauge, order: 40, active: false, press: openUsage },
  ];
  const all = sortPageRailItems([...builtin, ...entries]);
  const settings = useMemo(
    () => ({
      key: "settings",
      label: "设置",
      icon: Settings,
      active: pathname.startsWith("/settings") && !pathname.endsWith("/prompts"),
      press: () => router.push(buildSettingsRoute()),
    }),
    [pathname],
  );
  return (
    <View style={[styles.rail, horizontal && styles.horizontal]}>
      {all.map((entry) => (
        <RailButton key={entry.key} entry={entry} onNavigate={onNavigate} />
      ))}
      <View style={styles.spacer} />
      <RailButton entry={settings} onNavigate={onNavigate} />
    </View>
  );
}

const ThemedPluginIcon = withUnistyles(PluginIconView);
const activeIconProps = (theme: Theme) => ({ color: theme.colors.accentText });
const inactiveIconProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function RailButton({
  entry,
  onNavigate,
}: {
  entry: { key: string; label: string; icon: PluginIcon; active: boolean; press: () => void };
  onNavigate?: () => void;
}) {
  const accessibilityState = useMemo(() => ({ selected: entry.active }), [entry.active]);
  const press = useCallback(() => {
    onNavigate?.();
    entry.press();
  }, [entry, onNavigate]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={entry.label}
          accessibilityState={accessibilityState}
          testID={`page-rail-${entry.key}`}
          onPress={press}
          style={[styles.item, entry.active && styles.selected]}
        >
          <ThemedPluginIcon
            icon={entry.icon}
            size={20}
            uniProps={entry.active ? activeIconProps : inactiveIconProps}
          />
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="right">{entry.label}</TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: PAGE_RAIL_WIDTH,
    alignItems: "center",
    backgroundColor: theme.colors.surface0,
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  horizontal: { width: "100%", flexDirection: "row", paddingHorizontal: theme.spacing[2] },
  item: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  selected: { backgroundColor: theme.colors.accentSoft },
  spacer: { flex: 1 },
}));
