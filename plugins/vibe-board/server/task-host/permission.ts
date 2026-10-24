import type { Preset } from "../vibe/contract";
export function modeIdFor(provider: string, mode: Preset["permissionMode"]): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") {
    if (p === "claude") return "bypassPermissions";
    if (p === "codex") return "full-access";
    return "auto";
  }
  return mode === "auto" ? "auto" : undefined;
}
/** Roles that read the workspace must run under a provider-enforced read-only policy. */
export function readOnlyConfigFor(
  provider: string,
): { modeId?: string; options?: Record<string, unknown> } {
  const p = provider.toLowerCase();
  if (p === "claude") return { modeId: "plan" };
  if (p === "codex")
    return {
      modeId: "read-only",
      options: { sandbox_mode: "read-only", approval_policy: "never" },
    };
  throw new Error(`该 provider 尚无受支持的强制只读策略，不能打开只读 tab：${provider}`);
}
