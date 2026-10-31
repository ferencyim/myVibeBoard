/** Both workspace panels consume the same snapshot and share its cached result. */
export const taskPanelRefreshInterval = 15_000;
export const taskPanelQueryKey = (workspaceId: string) => ["vibe-board", "task-panel", workspaceId] as const;
