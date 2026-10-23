// Permission mode of the master and planning agents. The setting "auto" (default) means "the
// provider's own automatic-approval mode"; any other value is a concrete Paseo modeId of the
// provider. The catalog (providers.listModes) is the source of truth for what a provider offers.

import type { MasterPaseo } from "../types";

/** The setting value that selects the provider's automatic mode. */
export const AUTO = "auto";
/** Setting value of the manual switch that hands control back to the settings default. */
export const FOLLOW_SETTINGS = "settings";

/**
 * Automatic mode per provider, best first: Claude's classifier mode, Codex's auto-reviewer, else
 * the Codex default flow (closest below Full Access). Unknown providers try a mode named "auto".
 */
const AUTO_CANDIDATES: Record<string, string[]> = {
  claude: ["auto"],
  codex: ["auto-review", "auto"],
};

export interface ModeOption {
  id: string;
  label: string;
}

export interface ResolvedPermission {
  /** Null = the provider's own default (nothing to pass). */
  modeId: string | null;
  label: string;
  /** The setting asked for the automatic mode. */
  auto: boolean;
  /** Selectable concrete modes of the provider (the special "auto" entry excluded). */
  options: ModeOption[];
}

export interface PermissionResolver {
  resolve(provider: string, requested: string): Promise<ResolvedPermission>;
}

type ModesApi = Pick<MasterPaseo["providers"], "listModes">;

export function createPermissionResolver(getPaseo: () => { providers: ModesApi } | null): PermissionResolver {
  const cache = new Map<string, ModeOption[]>();

  async function modesOf(provider: string): Promise<ModeOption[] | null> {
    const hit = cache.get(provider);
    if (hit) return hit;
    const paseo = getPaseo();
    if (!paseo?.providers.listModes) return null;
    try {
      const res = await paseo.providers.listModes(provider);
      if (res.error || !res.modes?.length) return null;
      const modes = res.modes.map((m) => ({ id: m.id, label: m.label }));
      cache.set(provider, modes);
      return modes;
    } catch {
      return null;
    }
  }

  return {
    async resolve(provider, requested) {
      const catalog = await modesOf(provider);
      const labelOf = (id: string) => catalog?.find((m) => m.id === id)?.label ?? id;
      const options = (catalog ?? []).filter((m) => m.id !== AUTO);
      const done = (modeId: string | null, auto: boolean): ResolvedPermission => ({
        modeId,
        label: modeId ? labelOf(modeId) : "Provider default",
        auto,
        options,
      });
      const semantic: Record<string, Record<string, string>> = {
        claude: { "accept-edits": "acceptEdits", full: "bypassPermissions" },
        codex: { "accept-edits": "auto", full: "full-access" },
      };
      const wanted = semantic[provider]?.[requested] ?? (requested || AUTO).trim();
      if (semantic[provider]?.[requested] && (!catalog || catalog.some((m) => m.id === wanted))) return done(wanted, false);
      if (wanted && wanted !== AUTO && (!catalog || catalog.some((m) => m.id === wanted))) {
        return done(wanted, false);
      }
      const candidates = AUTO_CANDIDATES[provider] ?? [AUTO];
      // Without a catalog (provider not ready) the first candidate is used and the daemon validates it.
      const pick = catalog ? candidates.find((c) => catalog.some((m) => m.id === c)) : candidates[0];
      return done(pick ?? null, true);
    },
  };
}

interface RequestLike {
  kind: string;
  name?: string;
  metadata?: unknown;
}

/**
 * A call of a tool of the vibe-board MCP server. Codex asks via "CodexMcpElicitation" (server name
 * in metadata), Claude names the permission after the tool. Nothing else is ever approved here.
 */
export function isBoardMcpCall(request: RequestLike): boolean {
  if (request.kind !== "tool") return false;
  if (request.name?.startsWith("mcp__vibe-board__")) return true;
  const meta = request.metadata && typeof request.metadata === "object" ? (request.metadata as Record<string, unknown>) : {};
  return request.name === "CodexMcpElicitation" && meta.serverName === "vibe-board";
}
