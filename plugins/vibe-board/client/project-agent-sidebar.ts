import type { ProjectAgentState } from "../shared/project-agent";

export function createProjectAgentRequest(projectId: string, displayName = "项目 agent") {
  return { projectId, displayName, active: true, opening: false, navigate: false };
}

type ProjectAgentRequest = ReturnType<typeof createProjectAgentRequest>;

export function deactivateProjectAgentRequest(request: ProjectAgentRequest) {
  request.active = false;
  request.navigate = false;
}

export function receiveProjectAgentState(
  request: ProjectAgentRequest,
  state: ProjectAgentState | undefined,
  openAgent: (id: string) => void,
) {
  if (!request.active || !request.navigate) return;
  if (state?.status === "ready" && state.agentId) {
    request.navigate = false;
    openAgent(state.agentId);
  } else if (state?.status === "failed") {
    request.navigate = false;
  }
}

export async function openProjectAgentRequest(
  request: ProjectAgentRequest,
  ports: {
    cancelQueries(): Promise<unknown>;
    open(projectId: string): Promise<ProjectAgentState>;
    setState(state: ProjectAgentState): void;
    setOpening(opening: boolean): void;
    setError(error: string | null): void;
    openAgent(id: string): void;
    /** 已知主对话 agent：点击立即导航，open RPC 在后台确认。 */
    knownAgentId?: string | null;
  },
) {
  if (!request.active || request.opening) return;
  request.opening = true;
  const known = ports.knownAgentId ?? null;
  if (known) ports.openAgent(known);
  else ports.setOpening(true);
  ports.setError(null);
  try {
    await ports.cancelQueries();
    if (!request.active) return;
    const result = await ports.open(request.projectId);
    if (!request.active) return;
    request.navigate = result.status === "creating" && !known;
    ports.setState(result);
    if (result.status === "ready" && result.agentId && result.agentId !== known) ports.openAgent(result.agentId);
    if (result.error) ports.setError(result.error);
  } catch {
    if (request.active) ports.setError(`暂时无法打开${request.displayName}，请重试。`);
  } finally {
    request.opening = false;
    if (request.active) ports.setOpening(false);
  }
}

export function projectAgentPollInterval(state: ProjectAgentState | undefined) {
  return state?.status === "creating" ? 1_000 : 15_000;
}

export function projectAgentPresentation(
  state: ProjectAgentState | undefined,
  opening: boolean,
  openError: string | null,
  displayName = "项目 agent",
) {
  const error = openError ?? state?.error;
  const creating = state?.status === "creating";
  let label = displayName;
  if (error) label = `重试打开${displayName}`;
  if (opening) label = "正在打开…";
  if (opening && displayName === "项目 agent") label = "正在打开项目 agent…";
  if (creating) label = "正在创建…";
  if (creating && displayName === "项目 agent") label = "正在创建项目 agent…";
  return { label, error, disabled: opening || creating };
}

export async function projectBotWorkspaceProjection(
  botIds: readonly string[], workspaceIds: readonly string[],
  read: (id: string) => Promise<{ workspaceId: string | null }>,
) {
  const states: Array<{ workspaceId: string | null }> = [];
  for (let offset = 0; offset < botIds.length; offset += 4) {
    states.push(...await Promise.all(botIds.slice(offset, offset + 4).map(read)));
  }
  const allowed = new Set(workspaceIds);
  return states.flatMap((state) => state.workspaceId && allowed.has(state.workspaceId)
    ? [{ workspaceId: state.workspaceId, kind: "bot" as const }] : []);
}
