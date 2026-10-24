import type { Preset } from "../vibe/contract";

export interface RolePermissionConfig {
  modeId?: string;
  providerOptions?: Record<string, unknown>;
}

export function modeIdFor(provider: string, mode: Preset["permissionMode"]): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") {
    if (p === "claude") return "bypassPermissions";
    if (p === "codex") return "full-access";
    return "auto";
  }
  return mode === "auto" ? "auto" : undefined;
}
/** Roles that read the workspace must run under a provider-enforced read-only policy.
 *  The Codex read-only sandbox cannot start a shell on Windows, so there the role runs in a
 *  writable mode and the role prompt is the guard instead of the sandbox. */
export function readOnlyConfigFor(
  provider: string,
  platform: NodeJS.Platform = process.platform,
): RolePermissionConfig {
  const p = provider.toLowerCase();
  if (p === "claude") return { modeId: "plan" };
  if (p === "codex") {
    if (platform === "win32") return { modeId: "auto" };
    return {
      modeId: "auto",
      providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
    };
  }
  throw new Error(`该 provider 尚无受支持的强制只读策略，不能打开只读 tab：${provider}`);
}
/** The verifier must be able to run tests and builds; evidence is voided if the code tree changes. */
export function writableConfigFor(provider: string): RolePermissionConfig {
  const modeId = modeIdFor(provider, "auto");
  if (!modeId) throw new Error(`该 provider 尚无受支持的验证权限配置：${provider}`);
  return { modeId };
}
