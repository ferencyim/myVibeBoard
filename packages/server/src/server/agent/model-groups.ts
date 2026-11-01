import type { ModelGroup, ModelGroupEntry, ProviderUsage } from "@getpaseo/protocol/messages";

export const MODEL_GROUP_LABEL = "paseo.model-group";
export const MODEL_GROUP_ORDER_LABEL = "paseo.model-group-order";

/**
 * Uses the same subscription usage report the app displays: the provider is exhausted when any
 * window has nothing left and has not yet reset.
 */
export function isProviderExhausted(
  usage: ProviderUsage[],
  providerId: string,
  now = Date.now(),
): boolean {
  return usage.some(
    (report) =>
      report.providerId === providerId &&
      report.windows.some((window) => {
        const remaining =
          window.remainingPct ?? (window.usedPct == null ? null : 100 - window.usedPct);
        if (remaining == null || remaining > 0) return false;
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        return Number.isNaN(resetsAt) || resetsAt > now;
      }),
  );
}

export async function selectModelGroupEntry(
  group: ModelGroup,
  availability: (provider: string) => Promise<{ available: boolean; error: string | null }>,
  usage: ProviderUsage[],
  after?: Pick<ModelGroupEntry, "order" | "provider" | "model">,
): Promise<{ entry: ModelGroupEntry | null; reasons: string[] }> {
  const entries = [...group.entries].sort((a, b) => a.order - b.order);
  const index = after
    ? entries.findIndex(
        (entry) =>
          entry.order === after.order &&
          entry.provider === after.provider &&
          entry.model === after.model,
      )
    : -1;
  if (after && index < 0) return { entry: null, reasons: [] };
  const reasons: string[] = [];
  for (const entry of entries.slice(index + 1)) {
    const state = await availability(entry.provider);
    if (!state.available) {
      reasons.push(`${entry.provider}/${entry.model}: ${state.error ?? "provider unavailable"}`);
    } else if (isProviderExhausted(usage, entry.provider)) {
      reasons.push(`${entry.provider}/${entry.model}: usage exhausted`);
    } else {
      return { entry, reasons };
    }
  }
  return { entry: null, reasons };
}
