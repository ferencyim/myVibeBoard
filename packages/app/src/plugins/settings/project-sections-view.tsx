import type { PluginProjectSettingsSectionProps } from "@getpaseo/plugin/client";
import { withUnistyles } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useInstalledPlugins } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { collectProjectSettingsSections } from "./project-sections";

function ProjectSettingsSections({
  projectId,
  serverId,
  theme,
}: Omit<PluginProjectSettingsSectionProps, "compact">) {
  const compact = useIsCompactFormFactor();
  const plugins = useInstalledPlugins();
  return collectProjectSettingsSections(plugins, serverId).map(({ plugin, section }) => {
    const Component = section.Component;
    return (
      <SettingsSection
        key={`${serverId}:${projectId}:${plugin.id}:${section.id}`}
        title={plugin.i18n.resolve(section.title, plugin.locale)}
      >
        <SurfaceErrorBoundary installation={plugin} Surface={Component} resetKey={projectId}>
          <PluginInstallationProvider plugin={plugin}>
            <Component projectId={projectId} serverId={serverId} theme={theme} compact={compact} />
          </PluginInstallationProvider>
        </SurfaceErrorBoundary>
      </SettingsSection>
    );
  });
}

const ThemedProjectSettingsSections = withUnistyles(ProjectSettingsSections);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function PluginProjectSettingsSections(props: { projectId: string; serverId: string }) {
  return <ThemedProjectSettingsSections {...props} uniProps={themeMapping} />;
}
