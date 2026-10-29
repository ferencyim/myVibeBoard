import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { normalizeProjectSettingsRouteId } from "@/utils/host-routes";
import SettingsScreen from "@/screens/settings-screen";
import type { ProjectDocumentPage } from "./document-navigation";

export function ProjectDocumentsRoute({ page }: { page: ProjectDocumentPage }) {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    projectId?: string | string[];
    path?: string | string[];
  }>();
  const view = useMemo(
    () =>
      ({
        kind: "document",
        serverId: normalizeProjectSettingsRouteId(params.serverId),
        projectId: normalizeProjectSettingsRouteId(params.projectId),
        path: normalizeProjectSettingsRouteId(params.path) || undefined,
        page,
      }) as const,
    [params.serverId, params.projectId, params.path, page],
  );
  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
