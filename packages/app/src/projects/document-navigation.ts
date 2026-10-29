import type { DocumentSnapshot, LocalBriefChange } from "./document-cache";

export type ProjectDocumentPage = "brief" | "documents";

export function buildProjectDocumentRoute(
  serverId: string,
  projectId: string,
  page: ProjectDocumentPage,
  path?: string,
) {
  let pathname:
    | "/settings/hosts/[serverId]/project-brief/[projectId]"
    | "/settings/hosts/[serverId]/project-document/[projectId]"
    | "/settings/hosts/[serverId]/project-documents/[projectId]" =
    "/settings/hosts/[serverId]/project-documents/[projectId]";
  if (page === "brief") pathname = "/settings/hosts/[serverId]/project-brief/[projectId]";
  else if (path) pathname = "/settings/hosts/[serverId]/project-document/[projectId]";
  return {
    pathname,
    params: { serverId, projectId, ...(path ? { path } : {}) },
  };
}

export function projectDocumentEntries(
  state: DocumentSnapshot & { outbox: LocalBriefChange[] },
  connected: boolean,
) {
  const changes = [...state.pending, ...state.outbox];
  const local =
    changes.flatMap((change) => change.documents).findLast((doc) => doc.path === "AGENTS.md") ??
    changes.flatMap((change) => change.documents).findLast((doc) => doc.path === "CLAUDE.md");
  const brief =
    state.documents.find((doc) => doc.path === "AGENTS.md") ??
    state.documents.find((doc) => doc.path === "CLAUDE.md");
  const summary = (
    (local?.content ?? brief?.content ?? "尚无简介缓存")
      .replace(/[#*`>]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "（文件为空）"
  ).slice(0, 120);
  let syncStatus = "离线缓存";
  if (changes.length) syncStatus = `待合并 ${changes.length} 项`;
  else if (state.syncError) syncStatus = "同步未完成";
  else if (connected) syncStatus = state.documents.length ? "已同步" : "等待同步";
  return { summary, syncStatus, documentCount: state.documents.length };
}
