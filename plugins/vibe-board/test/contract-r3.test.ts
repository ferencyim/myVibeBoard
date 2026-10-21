import { describe, expect, it } from "vitest";
import { presetsCreateRpc, projectsCreateRpc, projectsUpdateRpc } from "../shared/rpc";
import { setupBoard } from "./helpers";

describe("round 3 contract through the board RPCs", () => {
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
