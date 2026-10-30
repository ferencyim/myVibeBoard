import { describe, expect, it } from "vitest";
import {
  EMPTY_ROLE_DRAFT,
  roleDraftOf,
  roleSettingBody,
  roleSettingName,
  saveRoleSetting,
  type RoleDraft,
  type RoleSettingApi,
} from "../client/presets/role-setting";
import type { Preset } from "../shared/vibe/contract";

function setting(over: Partial<Preset> = {}): Preset {
  return {
    id: "s1", name: "Worker", provider: "claude", model: "opus", thinking: "high", permissionMode: "full",
    environmentKind: "new-worktree", baseBranch: "main", runtimeEnv: "android-emulator", instructions: "先读文档",
    fallbackPresetIds: null, roleHints: [], roleHint: null, builtin: false, fastMode: true,
    ownerScope: null, ownerRole: null, createdAt: "", updatedAt: "", updatedHlc: "",
    models: [
      { provider: "claude", model: "opus", thinking: "high", permissionMode: "full" },
      { provider: "codex", model: "gpt", thinking: "", permissionMode: "auto" },
    ],
    ...over,
  } as Preset;
}

function fakeApi() {
  const calls: Array<{ kind: "create" | "update"; id?: string; body: Record<string, unknown> }> = [];
  const api: RoleSettingApi = {
    create: async (body) => {
      calls.push({ kind: "create", body });
      return setting({ id: "new" });
    },
    update: async (id, body) => {
      calls.push({ kind: "update", id, body });
      return setting({ id });
    },
  };
  return { api, calls };
}

describe("role settings", () => {
  it("reads every field a role stores out of a setting", () => {
    const draft = roleDraftOf(setting());
    expect(draft).toMatchObject({
      provider: "claude", model: "opus", thinking: "high", fastMode: true, instructions: "先读文档",
      permissionMode: "full", environmentKind: "new-worktree", baseBranch: "main", runtimeEnv: "android-emulator",
    });
    expect(draft.backups).toEqual([{ provider: "codex", model: "gpt", thinking: "", permissionMode: "auto" }]);
    expect(roleDraftOf(undefined)).toBe(EMPTY_ROLE_DRAFT);
  });

  it("writes the draft back with the first model mirrored into the top-level fields", () => {
    const body = roleSettingBody(roleDraftOf(setting()));
    expect(body).toMatchObject({ provider: "claude", model: "opus", thinking: "high", permissionMode: "full", fastMode: true });
    expect(body.models).toHaveLength(2);
  });

  it("edits a setting its scope and role own in place", async () => {
    const { api, calls } = fakeApi();
    const owned = setting({ ownerScope: "global", ownerRole: "worker" });
    const draft: RoleDraft = { ...roleDraftOf(owned), thinking: "low" };
    const id = await saveRoleSetting({ api, settings: [owned], current: owned, draft, scope: "global", scopeLabel: "全局", role: "worker" });
    expect(id).toBe("s1");
    expect(calls).toEqual([expect.objectContaining({ kind: "update", id: "s1" })]);
  });

  it("copies a shared or foreign setting instead of editing it, keeping every field", async () => {
    const { api, calls } = fakeApi();
    const shared = setting({ ownerScope: null, ownerRole: null });
    const draft: RoleDraft = { ...roleDraftOf(shared), model: "sonnet" };
    const id = await saveRoleSetting({ api, settings: [shared], current: shared, draft, scope: "proj1", scopeLabel: "项目", role: "reviewer" });
    expect(id).toBe("new");
    expect(calls[0]).toMatchObject({
      kind: "create",
      body: {
        name: "项目/reviewer", ownerScope: "proj1", ownerRole: "reviewer", model: "sonnet",
        instructions: "先读文档", runtimeEnv: "android-emulator", permissionMode: "full", fastMode: true,
      },
    });
    expect((calls[0]!.body.models as unknown[]).length).toBe(2);
  });

  it("refuses to store a role without a model and names copies uniquely", async () => {
    const { api } = fakeApi();
    await expect(
      saveRoleSetting({ api, settings: [], current: undefined, draft: EMPTY_ROLE_DRAFT, scope: "global", scopeLabel: "全局", role: "worker" }),
    ).rejects.toThrow("请先选择模型");
    expect(roleSettingName(["全局/worker", "全局/worker (2)"], "全局", "worker")).toBe("全局/worker (3)");
  });
});
