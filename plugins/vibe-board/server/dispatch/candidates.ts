import { presetModels, withPresetModel, type Preset } from "../vibe/contract";
import type { BoardService } from "../service";

/** Legacy fallback IDs are read only until the store migrates them into this preset. */
export function modelCandidates(preset: Preset, presets: Preset[]): Preset[] {
  const candidates = presetModels(preset).map((model) => withPresetModel(preset, model));
  if (!preset.models?.length) {
    for (const id of preset.fallbackPresetIds ?? []) {
      const next = presets.find((p) => p.id === id);
      if (next && !candidates.some((p) => p.id === id)) candidates.push(next);
    }
  }
  return candidates;
}

/** Persist the exact candidate against the session, so restarting never resets its position. */
export function recordModelSelection(board: BoardService, cardId: string, sessionId: string, preset: Preset, index: number) {
  board.store.events.add({
    cardId, type: "status", authorKind: "system", author: "failover",
    body: { kind: "model_selected", sessionId, presetId: preset.id, modelIndex: index, provider: preset.provider, model: preset.model },
  });
}
