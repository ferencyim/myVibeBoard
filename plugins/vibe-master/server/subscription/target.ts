// Resolve a provider (and optionally a model) into a concrete model from the provider catalog.
// Used for presets without a model (WP-109) and by the planning sessions.

import type { MasterTarget } from "../../shared/rpc";
import type { MasterPaseo, ModelInfoLike } from "../types";

export interface TargetRequest {
  provider: string;
  model?: string;
}

const MODEL_PREFERENCE: Record<string, RegExp> = { claude: /opus/i };
export function pickModel(models: ModelInfoLike[], provider: string, requested?: string): ModelInfoLike {
  const usable = models.filter((m) => m.isSelectable !== false);
  if (usable.length === 0) throw new Error(`Provider "${provider}" lists no selectable models`);
  if (requested) {
    const wanted = requested.toLowerCase();
    const found = usable.find(
      (m) => m.id.toLowerCase() === wanted || m.aliases?.some((a) => a.toLowerCase() === wanted),
    );
    if (!found) {
      throw new Error(
        `Model "${requested}" is not available for ${provider} (available: ${usable.map((m) => m.id).join(", ")})`,
      );
    }
    return found;
  }
  const preference = MODEL_PREFERENCE[provider];
  const preferred = preference && usable.find((m) => preference.test(m.id) || preference.test(m.label));
  return preferred ?? usable.find((m) => m.isDefault) ?? usable[0]!;
}

export async function resolveTarget(
  paseo: Pick<MasterPaseo, "providers">,
  request: TargetRequest,
): Promise<MasterTarget> {
  const listed = await paseo.providers.listModels(request.provider);
  if (listed.error && !listed.models?.length) {
    throw new Error(`Could not list models for ${request.provider}: ${listed.error}`);
  }
  const model = pickModel(listed.models ?? [], request.provider, request.model || undefined);
  return {
    provider: request.provider,
    model: model.id,
    thinking: null,
  };
}

export const sameTarget = (a: MasterTarget | null | undefined, b: MasterTarget | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model && (a.thinking ?? null) === (b.thinking ?? null);

/** `provider/model` as the SDK expects it. */
export const providerSpec = (t: Pick<MasterTarget, "provider" | "model">) =>
  t.model.startsWith(`${t.provider}/`) ? t.model : `${t.provider}/${t.model}`;
