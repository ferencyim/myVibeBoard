// Native session conversion for failure reassignment (WP-84), Claude <-> Codex only: the old
// agent's saved session file is converted to the other provider's session format with txcript and
// imported as a new Paseo agent in the same workspace. This follows plugins/switch-provider
// (server/convert.ts), whose txcript copy is reused: plugins cannot share modules, so the
// switch-provider plugin folder is located with `paseo plugin ls --json` and txcript is required
// from there. Everything is best effort: returning null (or throwing) makes the caller fall back to
// the Markdown transcript hand-off, which works for every provider.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConvertSession } from "./reassign";

const run = promisify(execFile);

/** Paseo provider id -> txcript harness id. */
const HARNESS: Record<string, string> = { claude: "claude_code", codex: "codex" };
/** Session files bigger than this are not converted (no compaction here): hand off a transcript instead. */
const MAX_SESSION_BYTES = 6_000_000;

export const canConvert = (from: string, to: string) =>
  from !== to && from in HARNESS && to in HARNESS;

const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const codexRoot = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

async function findFile(root: string, matches: (name: string) => boolean): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "subagents" || entry.name === "tool-results") continue;
      const found = await findFile(path, matches);
      if (found) return found;
    } else if (matches(entry.name)) return path;
  }
  return null;
}

const locateSource = (provider: string, sessionId: string) =>
  provider === "claude"
    ? findFile(claudeRoot(), (n) => n === `${sessionId}.jsonl`)
    : findFile(codexRoot(), (n) => n.startsWith("rollout-") && n.endsWith(`${sessionId}.jsonl`));

const stamp = (iso: string) => iso.replace(/[:.]/g, "-");
function targetPath(provider: string, cwd: string, id: string, iso: string) {
  if (provider === "claude") return join(claudeRoot(), cwd.replace(/[/\\.:]/g, "-"), `${id}.jsonl`);
  const [y, m, d] = iso.slice(0, 10).split("-");
  return join(codexRoot(), y!, m!, d!, `rollout-${stamp(iso.slice(0, 19))}-${id}.jsonl`);
}

type Txcript = { toCommon(text: string, from: string): string; fromCommon(json: string, to: string): string };

async function loadTxcript(): Promise<Txcript> {
  const { stdout } = await run("paseo", ["plugin", "ls", "--json"], { timeout: 30_000 });
  const plugins = JSON.parse(stdout) as { id: string; path?: string }[];
  const dir = plugins.find((plugin) => plugin.id === "switch-provider")?.path;
  if (!dir) throw new Error("switch-provider plugin (txcript) is not installed");
  return createRequire(join(dir, "package.json"))("txcript") as Txcript;
}

/** Imports a provider session as an agent in the workspace (same daemon-client route as switch-provider). */
async function importAgent(input: {
  provider: string;
  sessionId: string;
  cwd: string;
  workspaceId?: string;
  modelId: string;
}): Promise<string> {
  const { stdout } = await run("paseo", ["daemon", "status", "--json"], { timeout: 30_000 });
  const port = String(JSON.parse(stdout).listen).split(":").pop();
  const specifier = "@getpaseo/client/internal/daemon-client";
  const { DaemonClient } = (await import(/* @vite-ignore */ specifier)) as {
    DaemonClient: new (config: Record<string, unknown>) => {
      connect(): Promise<void>;
      close(): Promise<void>;
      importAgent(input: Record<string, unknown>): Promise<{ id: string }>;
      setAgentModel(id: string, model: string): Promise<unknown>;
    };
  };
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `vibe-board-failover-${Date.now()}`,
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
    await client.setAgentModel(agent.id, input.modelId).catch(() => undefined);
    return agent.id;
  } finally {
    await client.close();
  }
}

export const convertNative: ConvertSession = async ({ paseo, fromAgentId, fromProvider, to, workspaceId }) => {
  if (!canConvert(fromProvider, to.provider)) return null;
  const snapshot = (await paseo.agents.ref(fromAgentId).refresh())?.agent;
  const sessionId = snapshot?.persistence?.sessionId;
  if (!snapshot?.cwd || !sessionId) return null; // never produced a saved session: hand off instead
  const source = await locateSource(fromProvider, sessionId);
  if (!source || (await stat(source)).size > MAX_SESSION_BYTES) return null;

  const txcript = await loadTxcript();
  const common = JSON.parse(txcript.toCommon(await readFile(source, "utf8"), HARNESS[fromProvider]!));
  const newSessionId = randomUUID();
  common.meta.id = newSessionId;
  common.meta.model = to.model;
  common.meta.cwd = snapshot.cwd;
  const path = targetPath(to.provider, snapshot.cwd, newSessionId, new Date().toISOString());
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, txcript.fromCommon(JSON.stringify(common), HARNESS[to.provider]!), { flag: "wx" });
  return importAgent({
    provider: to.provider,
    sessionId: newSessionId,
    cwd: snapshot.cwd,
    workspaceId: workspaceId ?? snapshot.workspaceId ?? undefined,
    modelId: to.model,
  });
};
