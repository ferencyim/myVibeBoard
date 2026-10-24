import type { Preset } from "../vibe/contract";

/** Only Claude and Codex have a stable set of named modes; every other provider keeps its own
 *  default permissions and receives no modeId (an unknown mode would break agent creation). */
export function modeIdFor(provider: string, mode: Preset["permissionMode"]): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") {
    if (p === "claude") return "bypassPermissions";
    if (p === "codex") return "full-access";
    return undefined;
  }
  if (mode !== "auto") return undefined;
  return p === "claude" || p === "codex" ? "auto" : undefined;
}
