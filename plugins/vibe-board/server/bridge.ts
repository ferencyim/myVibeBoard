import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { runTasksCli } from "./cli-runner";
import type { TasksApiStore, TasksDomain } from "./domain";

export interface TasksBridgeHandle {
  readonly url: string;
  readonly token: string;
  readonly binDir: string;
  readonly mcpScriptPath: string;
  close(): Promise<void>;
}

const MCP_TOOLS = [
  {
    name: "tasks_projects",
    description:
      "List all Paseo Tasks tracker projects, their key prefixes (e.g. PROD), and linked Paseo project IDs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "tasks_list",
    description:
      "List and filter tasks in Paseo Tasks by project prefix, status, priority, active agents, or search query.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Tracker project prefix or ID (e.g. PROD)",
        },
        status: {
          type: "string",
          enum: [
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "done",
            "canceled",
          ],
          description: "Filter by workflow status",
        },
        priority: {
          type: "string",
          enum: ["urgent", "high", "medium", "low", "none"],
          description: "Filter by task priority",
        },
        activeOnly: {
          type: "boolean",
          description: "Keep only tasks with an active agent working",
        },
        search: {
          type: "string",
          description: "Search text in task key, title, or description",
        },
        limit: {
          type: "number",
          description: "Maximum tasks to return (1-500, default 100)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tasks_show",
    description:
      "Show full details for a task by key (e.g. PROD-1) or ULID, including subtasks, comments, attachments, and attached agent threads.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1 or task ULID",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_create",
    description: "Create a new task in Paseo Tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Tracker project prefix or ID (e.g. PROD)",
        },
        title: {
          type: "string",
          description: "Task title",
        },
        description: {
          type: "string",
          description: "Markdown task description",
        },
        priority: {
          type: "string",
          enum: ["urgent", "high", "medium", "low", "none"],
          description: "Task priority (default: none)",
        },
        dueDate: {
          type: "string",
          description: "Optional due date in YYYY-MM-DD format",
        },
        parent: {
          type: "string",
          description: "Optional parent task key (e.g. PROD-1) for a subtask",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_update",
    description:
      "Update a task's workflow status, priority, title, description, or due date. Use in_review when implementation is ready for review, or done when complete.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1",
        },
        status: {
          type: "string",
          enum: [
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "done",
            "canceled",
          ],
        },
        priority: {
          type: "string",
          enum: ["urgent", "high", "medium", "low", "none"],
        },
        title: {
          type: "string",
        },
        description: {
          type: "string",
        },
        dueDate: {
          type: "string",
          description: "YYYY-MM-DD or empty string to clear",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_comment",
    description:
      "Add a substantive Markdown comment to a task, optionally notifying and resuming the latest responding agent.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1",
        },
        body: {
          type: "string",
          description: "Markdown comment body",
        },
        notify: {
          type: "boolean",
          description:
            "Deliver the comment to the latest responding agent on the task",
        },
        threadId: {
          type: "string",
          description: "Optional invoking agent ID",
        },
      },
      required: ["key", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_delegate",
    description:
      "Delegate a task to a new Paseo agent thread using an execution preset.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1",
        },
        preset: {
          type: "string",
          description: "Preset name or ID from paseo-tasks preset list",
        },
        instructions: {
          type: "string",
          description: "Optional extra instructions for this dispatch",
        },
      },
      required: ["key", "preset"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_attach",
    description: "Attach an agent session to a task.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1",
        },
        threadId: {
          type: "string",
          description: "Agent ID to attach (defaults to PASEO_AGENT_ID)",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_detach",
    description: "Detach an agent session from a task.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Task key such as PROD-1",
        },
        threadId: {
          type: "string",
          description: "Agent ID to detach (defaults to PASEO_AGENT_ID)",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
] as const;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

async function executeMcpToolCall(
  name: string,
  args: Record<string, unknown>,
  store: TasksApiStore,
  domain: TasksDomain,
  defaultThreadId?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const argv: string[] = [];
  const threadId =
    (typeof args.threadId === "string" && args.threadId.trim()) ||
    defaultThreadId;

  switch (name) {
    case "tasks_projects":
      argv.push("project", "list", "--json");
      break;
    case "tasks_list":
      argv.push("list", "--json");
      if (typeof args.project === "string" && args.project) {
        argv.push("--project", args.project);
      }
      if (typeof args.status === "string" && args.status) {
        argv.push("--status", args.status);
      }
      if (typeof args.priority === "string" && args.priority) {
        argv.push("--priority", args.priority);
      }
      if (args.activeOnly === true) {
        argv.push("--active");
      }
      if (typeof args.search === "string" && args.search) {
        argv.push("--search", args.search);
      }
      if (typeof args.limit === "number") {
        argv.push("--limit", String(args.limit));
      }
      break;
    case "tasks_show":
      argv.push("show", String(args.key ?? ""), "--json");
      break;
    case "tasks_create":
      argv.push("create", "--title", String(args.title ?? ""), "--json");
      if (typeof args.project === "string" && args.project) {
        argv.push("--project", args.project);
      }
      if (typeof args.description === "string") {
        argv.push("--description", args.description);
      }
      if (typeof args.priority === "string" && args.priority) {
        argv.push("--priority", args.priority);
      }
      if (typeof args.dueDate === "string" && args.dueDate) {
        argv.push("--due", args.dueDate);
      }
      if (typeof args.parent === "string" && args.parent) {
        argv.push("--parent", args.parent);
      }
      break;
    case "tasks_update":
      argv.push("update", String(args.key ?? ""), "--json");
      if (typeof args.status === "string" && args.status) {
        argv.push("--status", args.status);
      }
      if (typeof args.priority === "string" && args.priority) {
        argv.push("--priority", args.priority);
      }
      if (typeof args.title === "string" && args.title) {
        argv.push("--title", args.title);
      }
      if (typeof args.description === "string") {
        argv.push("--description", args.description);
      }
      if (typeof args.dueDate === "string") {
        if (args.dueDate === "") argv.push("--no-due");
        else argv.push("--due", args.dueDate);
      }
      break;
    case "tasks_comment":
      argv.push(
        "comment",
        String(args.key ?? ""),
        "--body",
        String(args.body ?? ""),
        "--json",
      );
      if (args.notify === true) argv.push("--notify");
      break;
    case "tasks_delegate":
      argv.push(
        "delegate",
        String(args.key ?? ""),
        "--preset",
        String(args.preset ?? ""),
        "--json",
      );
      if (typeof args.instructions === "string" && args.instructions) {
        argv.push("--instructions", args.instructions);
      }
      break;
    case "tasks_attach":
      argv.push("attach", String(args.key ?? ""), "--json");
      if (threadId) argv.push("--thread", threadId);
      break;
    case "tasks_detach":
      argv.push("detach", String(args.key ?? ""), "--json");
      if (threadId) argv.push("--thread", threadId);
      break;
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }

  const res = await runTasksCli(argv, store, domain, { threadId });
  return {
    isError: res.exitCode !== 0,
    content: [{ type: "text", text: res.stdout || res.stderr || "" }],
  };
}

function buildCliWrapperScript(bridgeFilePath: string): string {
  return `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const bridgePath = process.env.PASEO_TASKS_BRIDGE_FILE || ${JSON.stringify(bridgeFilePath)};
let bridge;
try {
  bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
} catch {
  console.error("Error: Paseo Tasks plugin bridge is not active.");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const argv = rawArgs[0] === "tasks" ? rawArgs.slice(1) : rawArgs;

try {
  const response = await fetch(\`\${bridge.url}/cli\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: \`Bearer \${bridge.token}\`,
    },
    body: JSON.stringify({
      argv,
      cwd: process.cwd(),
      threadId: process.env.PASEO_AGENT_ID || process.env.BB_THREAD_ID,
      projectId: process.env.PASEO_PROJECT_ID || process.env.BB_PROJECT_ID,
    }),
  });
  const result = await response.json();
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith("\\n") ? result.stdout : result.stdout + "\\n");
  }
  if (result.stderr && (!result.stdout || result.exitCode !== 0)) {
    if (!result.stdout) {
      process.stderr.write(result.stderr.endsWith("\\n") ? result.stderr : result.stderr + "\\n");
    }
  }
  process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
} catch (error) {
  console.error("Error communicating with Paseo Tasks daemon:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
}

function buildMcpStdioScript(bridgeFilePath: string): string {
  return `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const bridgePath = process.env.PASEO_TASKS_BRIDGE_FILE || ${JSON.stringify(bridgeFilePath)};

function loadBridge() {
  return JSON.parse(readFileSync(bridgePath, "utf8"));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    const bridge = loadBridge();
    const res = await fetch(\`\${bridge.url}/mcp\`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: \`Bearer \${bridge.token}\`,
        ...(process.env.PASEO_AGENT_ID ? { "x-paseo-agent-id": process.env.PASEO_AGENT_ID } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (res.status === 204) return;
    const text = await res.text();
    if (text.trim()) {
      process.stdout.write(text.trim() + "\\n");
    }
  } catch (error) {
    if (msg && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      }) + "\\n");
    }
  }
});
`;
}

export async function startTasksBridge(
  store: TasksApiStore,
  domain: TasksDomain,
): Promise<TasksBridgeHandle> {
  const token = randomBytes(24).toString("hex");
  const dataDir = store.dataDir;
  const binDir = join(dataDir, "bin");
  const bridgeFilePath = join(dataDir, "bridge.json");
  const paseoTasksBin = join(binDir, "paseo-tasks");
  const bbTasksBin = join(binDir, "bb-tasks");
  const bbBin = join(binDir, "bb");
  const mcpScriptPath = join(binDir, "tasks-mcp.mjs");

  await mkdir(binDir, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && req.url === "/cli") {
        const body = (await readJsonBody(req)) as {
          argv?: string[];
          cwd?: string;
          threadId?: string;
          projectId?: string;
        };
        const result = await runTasksCli(
          Array.isArray(body.argv) ? body.argv : [],
          store,
          domain,
          {
            cwd: body.cwd,
            threadId: body.threadId,
            projectId: body.projectId,
          },
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && req.url === "/mcp") {
        const rpc = (await readJsonBody(req)) as {
          jsonrpc?: string;
          id?: string | number | null;
          method?: string;
          params?: Record<string, unknown>;
        };
        const agentIdHeader = req.headers["x-paseo-agent-id"];
        const defaultThreadId =
          typeof agentIdHeader === "string" ? agentIdHeader : undefined;

        if (!rpc.method) {
          sendJson(res, 400, { error: "invalid jsonrpc request" });
          return;
        }

        if (rpc.id === undefined) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (rpc.method === "initialize") {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: {
                name: "paseo-tasks",
                version: "0.1.0",
              },
            },
          });
          return;
        }

        if (rpc.method === "tools/list") {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: MCP_TOOLS,
            },
          });
          return;
        }

        if (rpc.method === "tools/call") {
          const toolName = String(rpc.params?.name ?? "");
          const toolArgs =
            (rpc.params?.arguments as Record<string, unknown> | undefined) ??
            {};
          const callResult = await executeMcpToolCall(
            toolName,
            toolArgs,
            store,
            domain,
            defaultThreadId,
          );
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: callResult,
          });
          return;
        }

        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {},
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Could not bind Tasks local bridge");
  }
  const url = `http://127.0.0.1:${addr.port}`;

  await writeFile(
    bridgeFilePath,
    JSON.stringify({ url, token, pid: process.pid }, null, 2),
    { mode: 0o600 },
  );

  const cliScript = buildCliWrapperScript(bridgeFilePath);
  await writeFile(paseoTasksBin, cliScript, { mode: 0o755 });
  await chmod(paseoTasksBin, 0o755);
  await writeFile(bbTasksBin, cliScript, { mode: 0o755 });
  await chmod(bbTasksBin, 0o755);
  await writeFile(bbBin, cliScript, { mode: 0o755 });
  await chmod(bbBin, 0o755);

  const mcpScript = buildMcpStdioScript(bridgeFilePath);
  await writeFile(mcpScriptPath, mcpScript, { mode: 0o755 });
  await chmod(mcpScriptPath, 0o755);

  return {
    url,
    token,
    binDir,
    mcpScriptPath,
    async close() {
      await rm(bridgeFilePath, { force: true }).catch(() => undefined);
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}
