import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export function presentWorkspaceFlowTab(
  title: string,
  disabled: boolean,
  status: SidebarStateBucket | null,
) {
  const parts = title.split(" · ");
  if (parts.length > 1 && status === "needs_input") parts[parts.length - 1] = "待审批";
  else if (parts.length > 1 && status === "running") parts[parts.length - 1] = "忙碌";
  return {
    label: parts[0] ?? title,
    tooltip: `${parts.join(" · ")}${disabled ? " · 点击启用" : ""}`,
    disabled,
    statusBucket: status,
  };
}
