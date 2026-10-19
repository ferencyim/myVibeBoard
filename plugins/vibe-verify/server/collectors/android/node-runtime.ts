// Real ProcessSpawner (emulator, Metro). The Runner is createNodeRunner from ../common.

import { spawn } from "node:child_process";
import type { ProcessSpawner } from "./types";

export function createNodeSpawner(): ProcessSpawner {
  return {
    spawn(command, args, options = {}) {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: (process.platform === "win32" && /^(npx|npm)$/i.test(command)),
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      return {
        pid: child.pid,
        kill() {
          // Windows: kill the whole tree (Metro spawns node children).
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
          } else {
            child.kill();
          }
        },
      };
    },
  };
}
