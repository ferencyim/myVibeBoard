import { useCallback } from "react";
import { useRouter } from "expo-router";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { NavigationRow } from "@/components/ui/navigation-row";
import { useProjectDocuments } from "./use-project-documents";
import { buildProjectDocumentRoute, projectDocumentEntries } from "./document-navigation";

// Host-owned cached entries remain available during offline cold starts.
export function ProjectDocumentsSection({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}) {
  const { state, connected, loaded, error } = useProjectDocuments(serverId, projectId);
  const router = useRouter();
  const openBrief = useCallback(
    () => router.push(buildProjectDocumentRoute(serverId, projectId, "brief")),
    [router, serverId, projectId],
  );
  const openDocuments = useCallback(
    () => router.push(buildProjectDocumentRoute(serverId, projectId, "documents")),
    [router, serverId, projectId],
  );
  const entries = projectDocumentEntries(state, connected);
  return (
    <SettingsSection title="项目资料">
      <View style={styles.card}>
        <NavigationRow
          title="项目简介"
          description={entries.summary}
          status={loaded ? entries.syncStatus : "读取缓存…"}
          onPress={openBrief}
          testID="project-brief-entry"
        />
        <NavigationRow
          title="项目文档"
          description={`${entries.documentCount} 份文档`}
          onPress={openDocuments}
          testID="project-documents-entry"
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </SettingsSection>
  );
}
const styles = StyleSheet.create((theme) => ({
  card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.borderRadius.lg },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
