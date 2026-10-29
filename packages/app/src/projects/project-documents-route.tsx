import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { normalizeProjectSettingsRouteId } from "@/utils/host-routes";
import { ProjectDocumentsPage } from "./project-documents-page";
import type { ProjectDocumentPage } from "./document-navigation";

export function ProjectDocumentsRoute({ page }: { page: ProjectDocumentPage }) {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    projectId?: string | string[];
    path?: string | string[];
  }>();
  return (
    <HostRouteBootstrapBoundary>
      <ProjectDocumentsPage
        serverId={normalizeProjectSettingsRouteId(params.serverId)}
        projectId={normalizeProjectSettingsRouteId(params.projectId)}
        path={normalizeProjectSettingsRouteId(params.path) || undefined}
        page={page}
      />
    </HostRouteBootstrapBoundary>
  );
}
