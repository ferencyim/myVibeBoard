import type { ProjectAgentState } from "../shared/project-agent";

export function createProjectAgentRequest(projectId: string) {
  return { projectId, active: true, opening: false, navigate: false };
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
  },
) {
  if (!request.active || request.opening) return;
  request.opening = true;
  ports.setOpening(true);
  ports.setError(null);
  try {
    await ports.cancelQueries();
    if (!request.active) return;
    const result = await ports.open(request.projectId);
    if (!request.active) return;
    request.navigate = result.status === "creating";
    ports.setState(result);
    if (result.status === "ready" && result.agentId) ports.openAgent(result.agentId);
    if (result.error) ports.setError(result.error);
  } catch {
    if (request.active) ports.setError("暂时无法打开项目 agent，请重试。");
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
) {
  const error = openError ?? state?.error;
  const creating = state?.status === "creating";
  let label = "项目 agent";
  if (error) label = "重试打开项目 agent";
  if (opening) label = "正在打开项目 agent…";
  if (creating) label = "正在创建项目 agent…";
  return { label, error, disabled: opening || creating };
}
