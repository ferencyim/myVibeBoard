import { Redirect, useLocalSearchParams } from "expo-router";
import { PluginSurfaceScreen } from "@/plugins";
import { useInstalledPlugin } from "@/plugins/registry";
import { buildPluginSurfaceRoute } from "@/plugins/routes";

export default function PluginSurfaceRoute() {
  const { serverId, pluginId, contributionKind, contributionId } = useLocalSearchParams<{
    serverId: string;
    pluginId: string;
    contributionKind: string;
    contributionId: string;
  }>();
  const plugin = useInstalledPlugin(serverId, pluginId);
  const railItem =
    contributionKind === "sidebar"
      ? plugin?.pageRailItems?.find((item) => item.id === contributionId)
      : undefined;
  if (railItem)
    return (
      <Redirect
        href={buildPluginSurfaceRoute(serverId, pluginId, {
          kind: "surface",
          id: railItem.screenId,
        })}
      />
    );
  return <PluginSurfaceScreen />;
}
