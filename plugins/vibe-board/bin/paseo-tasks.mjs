#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
const dataDir =
  process.env.PASEO_TASKS_DATA_DIR?.trim() ||
  join(paseoHome, "plugin-data", "tasks");
const bridgePath =
  process.env.PASEO_TASKS_BRIDGE_FILE?.trim() || join(dataDir, "bridge.json");

const rawArgs = process.argv.slice(2);
const argv = rawArgs[0] === "tasks" ? rawArgs.slice(1) : rawArgs;

if (existsSync(bridgePath)) {
  try {
    const bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
    const response = await fetch(`${bridge.url}/cli`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({
        argv,
        cwd: process.cwd(),
        threadId: process.env.PASEO_AGENT_ID || process.env.BB_THREAD_ID,
        projectId: process.env.PASEO_PROJECT_ID || process.env.BB_PROJECT_ID,
      }),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.stdout) {
        process.stdout.write(
          result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`,
        );
      }
      if (result.stderr && (!result.stdout || result.exitCode !== 0)) {
        if (!result.stdout) {
          process.stderr.write(
            result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`,
          );
        }
      }
      process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
    }
  } catch {
    // Fall through to standalone execution if the daemon bridge is not reachable
  }
}

console.error(
  "Error: Paseo Tasks plugin bridge is not active. Ensure the 'tasks' plugin is running in Paseo.",
);
process.exit(1);
