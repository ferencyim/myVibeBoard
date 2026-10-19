#!/usr/bin/env node
// Standalone entry for the `vibe-board` CLI: forwards argv to the running plugin's local bridge.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const vibeHome = process.env.VIBE_HOME?.trim() || join(homedir(), ".vibe");
const bridgePath =
  process.env.VIBE_BOARD_BRIDGE_FILE?.trim() || join(vibeHome, "board", "bridge.json");
const withNewline = (text) => (text.endsWith("\n") ? text : `${text}\n`);

if (existsSync(bridgePath)) {
  try {
    const bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
    const response = await fetch(`${bridge.url}/cli`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        agentId: process.env.PASEO_AGENT_ID,
        role: process.env.VIBE_ROLE,
      }),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.stdout) process.stdout.write(withNewline(result.stdout));
      if (result.stderr) process.stderr.write(withNewline(result.stderr));
      process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
    }
  } catch {
    // fall through: bridge not reachable
  }
}

console.error(
  "Error: the vibe-board plugin bridge is not active. Make sure the plugin is running in Paseo.",
);
process.exit(1);
