import { create } from "zustand";

interface WorkspaceTitleState {
  suffix: string | null;
  owner: symbol | null;
  setTitle: (owner: symbol, suffix: string | null) => void;
  clearTitle: (owner: symbol) => void;
}

export const useWorkspaceTitleStore = create<WorkspaceTitleState>((set) => ({
  suffix: null,
  owner: null,
  setTitle: (owner, suffix) => set({ owner, suffix }),
  clearTitle: (owner) =>
    set((state) => (state.owner === owner ? { owner: null, suffix: null } : state)),
}));

export function workspaceTitleSuffix(project: string, name: string | null): string | null {
  const label = name?.trim();
  if (!label) return null;
  const projectName = project.trim();
  return projectName ? `${projectName}/${label}` : label;
}

export function desktopWindowTitle(productName: string, suffix: string | null): string {
  return suffix ? `${productName} - ${suffix}` : productName;
}

/** Project labels come only from the native project record for a task or project bot. */
export function resolveWorkspaceTitle(input: {
  taskName: string | null;
  isTask: boolean;
  bot: { name: string; kind?: "independent" | "project"; projectId?: string | null } | undefined;
  sessionName: string | null;
  projectName: string | null;
}): { project: string; name: string | null } {
  if (input.isTask) return { project: input.projectName ?? "", name: input.taskName };
  if (input.bot)
    return {
      project: input.bot.kind === "project" && input.bot.projectId ? (input.projectName ?? "") : "",
      name: input.bot.name,
    };
  return { project: "", name: input.sessionName };
}
