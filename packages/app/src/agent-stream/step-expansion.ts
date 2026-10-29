export function defaultStepGroupExpanded(autoExpandReasoning: boolean, compact: boolean): boolean {
  return autoExpandReasoning && !compact;
}

export function isStepGroupExpanded(
  defaultExpanded: boolean,
  overrides: ReadonlySet<string>,
  id: string,
): boolean {
  return defaultExpanded !== overrides.has(id);
}

export function setStepGroupExpanded(
  defaultExpanded: boolean,
  overrides: ReadonlySet<string>,
  id: string,
  expanded: boolean,
): Set<string> {
  const next = new Set(overrides);
  if (expanded === defaultExpanded) next.delete(id);
  else next.add(id);
  return next;
}
