import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const run = promisify(execFile);

/**
 * Imports a provider session as an agent inside the given workspace, then sets its model.
 * `paseo import` cannot choose a workspace and the SDK has no import call, so this uses the daemon client
 * directly (an internal @getpaseo/client path).
 * ponytail: depends on that internal path, so a Paseo release that moves it breaks the import.
 */
export async function importAgent(input: {
  provider: string;
  sessionId: string;
  cwd: string;
  workspaceId?: string;
  modelId: string;
}) {
  const { stdout } = await run("paseo", ["daemon", "status", "--json"], { timeout: 30_000 });
  const port = String(JSON.parse(stdout).listen).split(":").pop();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `switch-provider-${Date.now()}`,
    clientType: "cli",
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    const agent = await client.importAgent({
      provider: input.provider,
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
    });
    // ponytail: best effort. If this fails the agent still runs on the provider's default model; pick another in the composer.
    await client.setAgentModel(agent.id, input.modelId).catch(() => undefined);
    return agent.id;
  } finally {
    await client.close();
  }
}
