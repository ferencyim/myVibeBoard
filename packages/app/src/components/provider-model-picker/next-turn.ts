export interface NextTurnNotice {
  running: string;
  next: string;
}

/**
 * While a turn is running, a changed model or effort only takes effect on the next turn. The
 * picker accepts the new value at once; this says which value the running turn still uses.
 */
export function resolveNextTurnNotice(input: {
  isRunning: boolean;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
  runtimeThinkingId: string | null | undefined;
  configuredThinkingId: string | null | undefined;
  labelOf: (modelId: string) => string;
}): NextTurnNotice | null {
  if (!input.isRunning) return null;
  const modelChanged =
    Boolean(input.runtimeModelId) &&
    Boolean(input.configuredModelId) &&
    input.runtimeModelId !== input.configuredModelId;
  const thinkingChanged =
    Boolean(input.runtimeThinkingId) &&
    Boolean(input.configuredThinkingId) &&
    input.runtimeThinkingId !== input.configuredThinkingId;
  if (!modelChanged && !thinkingChanged) return null;
  const runningModel = input.runtimeModelId ?? input.configuredModelId ?? "";
  const nextModel = input.configuredModelId ?? runningModel;
  return {
    running: [input.labelOf(runningModel), thinkingChanged ? input.runtimeThinkingId : null]
      .filter(Boolean)
      .join(" · "),
    next: [input.labelOf(nextModel), thinkingChanged ? input.configuredThinkingId : null]
      .filter(Boolean)
      .join(" · "),
  };
}
