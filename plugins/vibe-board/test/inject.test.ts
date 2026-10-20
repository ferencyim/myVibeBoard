import { describe, expect, it } from "vitest";
import { injectBoard } from "../server/mcp/inject";
import { BOARD_INSTRUCTIONS_MARKER } from "../server/mcp/instructions";
import { toolsForRole } from "../server/mcp/tools";

const on = { instructions: true, cliAndMcp: true };
const active = { mcpScriptPath: "/x/mcp.mjs", bridgeFile: "/x/bridge.json" };
const req = (extra: Record<string, unknown> = {}) => ({ config: { provider: "codex/x" }, ...extra }) as any;

describe("injectBoard", () => {
  it("injects instructions and MCP into normal agents", () => {
    const out = injectBoard(req(), on, active, "node");
    expect(out.config.systemPrompt).toContain(BOARD_INSTRUCTIONS_MARKER);
    expect(out.config.mcpServers["vibe-board"].env).toEqual({ VIBE_BOARD_BRIDGE_FILE: "/x/bridge.json" });
  });

  it("leaves scouts untouched (env or label)", () => {
    for (const request of [req({ env: { VIBE_ROLE: "scout" } }), req({ labels: { role: "scout" } })]) {
      const out = injectBoard(request, on, active, "node");
      expect(out).toBe(request);
      expect(out.config.mcpServers).toBeUndefined();
      expect(out.config.systemPrompt).toBeUndefined();
    }
  });

  it("pins verifiers and reviewers to the read-only tool set", () => {
    for (const role of ["verifier", "reviewer"]) {
      const out = injectBoard(req({ labels: { role } }), on, active, "node");
      expect(out.config.mcpServers["vibe-board"].env.VIBE_ROLE).toBe("verifier");
    }
    expect(toolsForRole("verifier").map((t) => t.name).sort()).toEqual([
      "vibe_comment",
      "vibe_list",
      "vibe_projects",
      "vibe_show",
    ]);
    expect(toolsForRole("scout").some((t) => t.name === "vibe_scout")).toBe(false);
  });
});
