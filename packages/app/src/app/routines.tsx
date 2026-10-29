import { Redirect, router } from "expo-router";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { ListRow } from "@/ui/list-row";
import { StyleSheet } from "react-native-unistyles";
import { useInstalledPlugins } from "@/plugins/registry";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

export default function RoutinesRoute() {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const candidates = plugins.filter(
    (plugin) =>
      plugin.id === "vibe-bots" && plugin.surfaces.some((surface) => surface.id === "routines"),
  );
  const selected =
    hostFilters.length === 1
      ? candidates.filter((candidate) => candidate.serverId === hostFilters[0])
      : candidates;
  if (selected.length === 1) return <Redirect href={routeFor(selected[0].serverId)} />;
  return (
    <View style={styles.container}>
      <Text style={styles.title}>例程</Text>
      {selected.length ? (
        <Text style={styles.message}>选择要管理例程的主机</Text>
      ) : (
        <Text style={styles.message}>未找到支持例程的 bot 插件，请连接主机并更新插件。</Text>
      )}
      {selected.map((plugin) => (
        <HostRow
          key={plugin.serverId}
          serverId={plugin.serverId}
          label={hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId}
        />
      ))}
    </View>
  );
}
function routeFor(serverId: string) {
  return buildPluginSurfaceRoute(serverId, "vibe-bots", { kind: "surface", id: "routines" });
}
function HostRow({ serverId, label }: { serverId: string; label: string }) {
  const open = useCallback(() => router.push(routeFor(serverId)), [serverId]);
  return <ListRow title={label} onPress={open} />;
}
const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    gap: theme.spacing[3],
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg },
  message: { color: theme.colors.foregroundMuted },
}));
