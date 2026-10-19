// Loopback bridge: one authenticated HTTP server inside the daemon plugin process that serves
//   POST /cli  - the `vibe-board` CLI (thin wrapper script forwards argv)
//   POST /mcp  - the board MCP (stdio script forwards JSON-RPC lines)
// Port + token are published in <dataDir>/bridge.json (mode 0600).

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { runBoardCli } from "../cli/runner";
import type { BoardService } from "../service";
import { callMcpTool, toolsForRole } from "./tools";

export interface BoardBridgeHandle {
  readonly url: string;
  readonly token: string;
  readonly binDir: string;
  readonly bridgeFile: string;
  readonly mcpScriptPath: string;
  close(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body.trim() ? JSON.parse(body) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" && value ? value : undefined;
};

/** Wrapper installed on PATH as `vibe-board`: forwards argv to /cli. */
export function buildCliWrapperScript(fallbackBridgeFile: string): string {
  return `import { readFileSync } from "node:fs";

const bridgePath = process.env.VIBE_BOARD_BRIDGE_FILE || ${JSON.stringify(fallbackBridgeFile)};
let bridge;
try {
  bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
} catch {
  console.error("Error: the vibe-board plugin bridge is not active (is the plugin running?).");
  process.exit(1);
}

try {
  const response = await fetch(\`\${bridge.url}/cli\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${bridge.token}\` },
    body: JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      agentId: process.env.PASEO_AGENT_ID,
      role: process.env.VIBE_ROLE,
    }),
  });
  const result = await response.json();
  if (result.stdout) process.stdout.write(result.stdout.endsWith("\\n") ? result.stdout : result.stdout + "\\n");
  if (result.stderr) process.stderr.write(result.stderr.endsWith("\\n") ? result.stderr : result.stderr + "\\n");
  process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
} catch (error) {
  console.error("Error talking to the vibe-board plugin:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
}

/** stdio MCP server: forwards each JSON-RPC line to /mcp. */
export function buildMcpStdioScript(fallbackBridgeFile: string): string {
  return `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const bridgePath = process.env.VIBE_BOARD_BRIDGE_FILE || ${JSON.stringify(fallbackBridgeFile)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
    const res = await fetch(\`\${bridge.url}/mcp\`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: \`Bearer \${bridge.token}\`,
        ...(process.env.PASEO_AGENT_ID ? { "x-vibe-agent-id": process.env.PASEO_AGENT_ID } : {}),
        ...(process.env.VIBE_ROLE ? { "x-vibe-role": process.env.VIBE_ROLE } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (res.status === 204) return;
    const body = (await res.text()).trim();
    if (body) process.stdout.write(body + "\\n");
  } catch (error) {
    if (msg && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }) + "\\n");
    }
  }
});
`;
}

export async function startBoardBridge(
  board: BoardService,
  dataDir: string,
): Promise<BoardBridgeHandle> {
  const token = randomBytes(24).toString("hex");
  const binDir = join(dataDir, "bin");
  const bridgeFile = join(dataDir, "bridge.json");
  const cliScriptPath = join(binDir, "vibe-board.mjs");
  const mcpScriptPath = join(binDir, "vibe-board-mcp.mjs");
  await mkdir(binDir, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && req.url === "/cli") {
        const body = (await readJsonBody(req)) as {
          argv?: string[];
          cwd?: string;
          agentId?: string;
          role?: string;
        };
        sendJson(
          res,
          200,
          await runBoardCli(Array.isArray(body.argv) ? body.argv : [], board, {
            cwd: body.cwd,
            agentId: body.agentId,
            role: body.role,
          }),
        );
        return;
      }

      if (req.method === "POST" && req.url === "/mcp") {
        const rpc = (await readJsonBody(req)) as {
          id?: string | number | null;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!rpc.method) {
          sendJson(res, 400, { error: "invalid jsonrpc request" });
          return;
        }
        if (rpc.id === undefined) {
          res.writeHead(204);
          res.end();
          return;
        }
        const caller = { agentId: header(req, "x-vibe-agent-id"), role: header(req, "x-vibe-role") };
        const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
        if (rpc.method === "initialize") {
          reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "vibe-board", version: "0.1.0" },
          });
        } else if (rpc.method === "tools/list") {
          reply({ tools: toolsForRole(caller.role) });
        } else if (rpc.method === "tools/call") {
          const args = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};
          reply(await callMcpTool(String(rpc.params?.name ?? ""), args, board, caller));
        } else {
          reply({});
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind the board bridge");
  const url = `http://127.0.0.1:${address.port}`;

  await writeFile(bridgeFile, JSON.stringify({ url, token, pid: process.pid }, null, 2), {
    mode: 0o600,
  });
  await writeFile(cliScriptPath, buildCliWrapperScript(bridgeFile));
  await writeFile(mcpScriptPath, buildMcpStdioScript(bridgeFile));
  // PATH shims: POSIX sh and Windows cmd both resolve `vibe-board` to the node wrapper.
  const shim = join(binDir, "vibe-board");
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/vibe-board.mjs" "$@"\n', { mode: 0o755 });
  await chmod(shim, 0o755);
  await writeFile(join(binDir, "vibe-board.cmd"), '@node "%~dp0vibe-board.mjs" %*\r\n');

  return {
    url,
    token,
    binDir,
    bridgeFile,
    mcpScriptPath,
    async close() {
      await rm(bridgeFile, { force: true }).catch(() => undefined);
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
