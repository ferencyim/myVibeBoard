import type { StepItem } from "../grouping";

/** The host row owns the group, while each trace entry keeps its source ID. */
export function waterfallStepIds(steps: readonly StepItem[]): string[] {
  return steps.map((step) => step.id);
}

export function waterfallScrollTarget(
  selectedId: string | null,
  offset: number | null,
): "wait" | "latest" | number {
  if (offset !== null) return offset;
  return selectedId ? "wait" : "latest";
}
