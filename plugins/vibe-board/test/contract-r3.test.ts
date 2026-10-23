import { describe, expect, it } from "vitest";
import { presetsCreateRpc, presetsListRpc, presetsUpdateRpc, projectsCreateRpc, projectsUpdateRpc } from "../shared/rpc";
import { setupBoard } from "./helpers";

describe("round 3 contract through the board RPCs", () => {
  it("lists migrated legacy presets whose empty model requests the provider default", () => {
    const { board, runtime: { store, db } } = setupBoard();
    const candidate = { provider: "claude", model: "opus", thinking: "high", permissionMode: "auto" as const };
    const preset = store.presets.create({ name: "legacy", ...candidate });
    db.prepare("UPDATE preset SET model = '', models_json = ? WHERE id = ?").run(
      JSON.stringify([{ ...candidate, model: "" }]), preset.id,
    );
    const output = presetsListRpc.output.parse(board.presets.list());
    expect(output.presets.find((item) => item.id === preset.id)).toMatchObject({
      model: "", models: [{ ...candidate, model: "" }],
    });
    expect(presetsUpdateRpc.input.safeParse({ presetId: preset.id, models: [{ ...candidate, model: "" }] }).success).toBe(false);
  });
  it("accepts ordered model candidates and rejects empty or incomplete candidates", () => {
    const candidate = { provider: "codex", model: "gpt", thinking: "high", permissionMode: "auto" };
    const input = { name: "n", provider: "claude", model: "opus", models: [candidate] };
    expect(presetsCreateRpc.input.parse(input).models).toEqual([candidate]);
    expect(presetsUpdateRpc.input.parse({ presetId: "p", models: [candidate] }).models).toEqual([candidate]);
    expect(presetsCreateRpc.input.safeParse({ ...input, models: [] }).success).toBe(false);
    expect(presetsUpdateRpc.input.safeParse({ presetId: "p", models: [{ ...candidate, model: " " }] }).success).toBe(false);
    const { board } = setupBoard();
    const { preset } = board.presets.create(presetsCreateRpc.input.parse(input));
    expect(preset).toMatchObject({ ...candidate, models: [candidate] });
  });
  it("project RPC schemas accept projectTypes / description / requirementsPath and reject bad values", () => {
    const base = { name: "P", prefix: "PP" };
    expect(projectsCreateRpc.input.safeParse({ ...base, projectTypes: ["web", "android"], description: "d", requirementsPath: "docs/R.md" }).success).toBe(true);
    for (const bad of [
      { projectTypes: [] },
      { projectTypes: ["web", "web"] },
      { requirementsPath: "/abs.md" },
      { requirementsPath: "../x.md" },
    ])
      expect(projectsCreateRpc.input.safeParse({ ...base, ...bad }).success).toBe(false);
    expect(projectsUpdateRpc.input.safeParse({ project: "PP", projectType: "ios" }).success).toBe(true);
  });

  it("service passes the new fields through and keeps the COMPAT fields consistent", () => {
    const { board } = setupBoard();
    const { project } = board.projects.create({
      name: "Multi",
      prefix: "MU",
      repoPath: "",
      projectTypes: ["web", "backend"],
      description: "a web app",
      requirementsPath: "docs/REQ.md",
    });
    expect(project).toMatchObject({ projectTypes: ["web", "backend"], projectType: "web", description: "a web app", requirementsPath: "docs/REQ.md" });
    expect(board.projects.update("MU", { projectType: "ios" }).project.projectTypes).toEqual(["ios"]);
  });

  it("preset RPC accepts roleHints and the service derives roleHint", () => {
    expect(presetsCreateRpc.input.safeParse({ name: "n", provider: "p", model: "m", roleHints: ["scout", "reviewer"] }).success).toBe(true);
    expect(presetsCreateRpc.input.safeParse({ name: "n", provider: "p", model: "m", roleHints: ["boss"] }).success).toBe(false);
    const { board } = setupBoard();
    const { preset } = board.presets.create({ name: "multi", provider: "claude", model: "m", roleHints: ["reviewer", "scout"] });
    expect(preset).toMatchObject({ roleHints: ["reviewer", "scout"], roleHint: "reviewer" });
  });
});
