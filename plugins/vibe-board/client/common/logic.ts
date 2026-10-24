import type { Project } from "../../shared/vibe/contract";
export { formatRpcError as errorMessage } from "../../shared/vibe/ui/rpc-error";
const PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];
export function projectColor(project: Pick<Project, "color">, index: number): string {
  const color = project.color?.trim();
  return color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)
    ? color
    : PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}
