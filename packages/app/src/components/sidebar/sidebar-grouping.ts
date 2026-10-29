export type SidebarGroupingMode = "project" | "date" | "status";
export type SidebarItemStatus = "needs_attention" | "running" | "idle" | "other";

/** The display layer retains its own data on each item; grouping only needs these fields. */
export interface SidebarGroupingItem {
  id: string;
  kind: "bot" | "task" | "session";
  projectId?: string | null;
  projectName?: string | null;
  isDefaultBot?: boolean;
  lastActivityAt?: string | number | Date | null;
  status: SidebarItemStatus;
}

export interface SidebarItemGroup<T extends SidebarGroupingItem> {
  key: string;
  title: string;
  projectId?: string;
  items: T[];
}

function activityTime(item: SidebarGroupingItem): number {
  if (item.lastActivityAt == null) return 0;
  const time =
    item.lastActivityAt instanceof Date
      ? item.lastActivityAt.getTime()
      : new Date(item.lastActivityAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** Groups are non-empty and rows are ordered by activity, with a project's default bot first. */
export function groupSidebarItems<T extends SidebarGroupingItem>(
  items: readonly T[],
  mode: SidebarGroupingMode,
  now: Date = new Date(),
): SidebarItemGroup<T>[] {
  const groups = new Map<string, SidebarItemGroup<T>>();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const dateKeys = ["today", "yesterday", "week", "older"];
  const statusKeys = ["needs_attention", "running", "idle", "other"];

  for (const item of items) {
    let key: string;
    let title: string;
    let projectId: string | undefined;
    if (mode === "project") {
      if (item.projectId) {
        projectId = item.projectId;
        key = `project:${projectId}`;
        title = item.projectName || projectId;
      } else if (item.kind === "bot") {
        key = "independent";
        title = "独立 bot";
      } else {
        key = "other";
        title = "其他";
      }
    } else if (mode === "date") {
      const time = activityTime(item);
      if (time >= today.getTime()) [key, title] = ["today", "今天"];
      else if (time >= yesterday.getTime()) [key, title] = ["yesterday", "昨天"];
      else if (time >= week.getTime()) [key, title] = ["week", "最近 7 天"];
      else [key, title] = ["older", "更早"];
    } else {
      key = item.status;
      title = { needs_attention: "需要你", running: "运行中", idle: "空闲", other: "其他" }[
        item.status
      ];
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, title, projectId, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.items.sort((a, b) => {
      if (mode === "project" && group.projectId) {
        const defaultOrder =
          Number(Boolean(b.kind === "bot" && b.isDefaultBot)) -
          Number(Boolean(a.kind === "bot" && a.isDefaultBot));
        if (defaultOrder) return defaultOrder;
      }
      return activityTime(b) - activityTime(a);
    });
  }
  if (mode === "project") {
    result.sort(
      (a, b) =>
        Number(b.key === "independent") - Number(a.key === "independent") ||
        Number(a.key === "other") - Number(b.key === "other"),
    );
  } else {
    const keys = mode === "date" ? dateKeys : statusKeys;
    result.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
  }
  return result;
}
