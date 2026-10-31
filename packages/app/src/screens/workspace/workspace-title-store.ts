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
