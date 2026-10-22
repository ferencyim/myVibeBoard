import { BOARD_INSTRUCTIONS_MARKER, buildBoardInstructions } from "./instructions";

interface InjectRequest {
  env?: Record<string, string>;
  labels?: Record<string, string>;
  config: { systemPrompt?: string; mcpServers?: Record<string, any> };
}

/** Role of an agent being created: VIBE_ROLE env first, then the role label. */
export function agentRoleOf(request: Pick<InjectRequest, "env" | "labels">): string | undefined {
  return request.env?.VIBE_ROLE || request.labels?.role || undefined;
}

/**
 * Adds the board instructions / MCP server to a new agent's config.
 * Scouts get neither (no recursion, no board access). Verifiers and reviewers get the MCP server with
 * VIBE_ROLE=verifier pinned, which limits it to the read-only tool set (toolsForRole).
 */
export function injectBoard<T extends InjectRequest>(
  request: T,
  inject: { instructions: boolean; cliAndMcp: boolean },
  active: { mcpScriptPath: string; bridgeFile: string } | null,
  processExecPath: string,
  /** Builds the instructions text (registry-backed); default texts when omitted. */
  instructionsText: () => string = buildBoardInstructions,
): T {
  const role = agentRoleOf(request);
  if (role === "scout") return request;
  const config = { ...request.config };
  if (inject.instructions && !(config.systemPrompt ?? "").includes(BOARD_INSTRUCTIONS_MARKER)) {
    config.systemPrompt = [config.systemPrompt ?? "", instructionsText()].filter(Boolean).join("\n\n");
  }
  if (inject.cliAndMcp && active) {
    const checking = role === "verifier" || role === "reviewer";
    config.mcpServers = {
      ...config.mcpServers,
      "vibe-board": {
        type: "stdio",
        command: processExecPath,
        args: [active.mcpScriptPath],
        env: {
          VIBE_BOARD_BRIDGE_FILE: active.bridgeFile,
          ...(checking ? { VIBE_ROLE: "verifier" } : {}),
          // Sub-agents never see the subtask tools, even on providers that do not pass env to MCP.
          ...(role === "subagent" ? { VIBE_ROLE: "subagent" } : {}),
        },
      },
    };
  }
  return { ...request, config };
}
