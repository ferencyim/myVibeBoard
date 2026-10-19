import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Bounded so a stuck command fails with a message instead of hanging the picker.
const run = (file: string, args: string[], options: { cwd?: string; maxBuffer?: number } = {}) =>
  execFileAsync(file, args, { ...options, timeout: 120_000 });

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: string | Block[]; timestamp?: string };

const newId = (prefix: string) => `${prefix}_${randomBytes(13).toString("hex")}`;
const time = (iso?: string) => (iso ? Date.parse(iso) : Date.now());
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return text(content ?? "");
  return content
    .map((part: Block) => (part.type === "text" ? String(part.text) : part.type === "image" ? "[image]" : text(part)))
    .join("\n");
}

// OpenCode truncates large exports written to a pipe, so redirect to a file and read that.
async function exportSession(id: string, cwd: string) {
  const dir = await mkdtemp(join(tmpdir(), "switch-provider-"));
  const file = join(dir, "export.json");
  try {
    await run("sh", ["-c", 'opencode session export "$0" > "$1"', id, file], { cwd });
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The projectID OpenCode assigned to this directory, read from its newest session there. */
export async function openCodeProjectId(cwd: string) {
  const list = await run("opencode", ["session", "list"], { cwd });
  const id = list.stdout.match(/ses_[A-Za-z0-9]+/)?.[0];
  if (!id) throw new Error(`OpenCode has no session in ${cwd} yet; start one there first so its project exists`);
  const projectID = (await exportSession(id, cwd)).match(/"projectID":\s*"([^"]+)"/)?.[1];
  if (!projectID) throw new Error("Could not read the OpenCode project id");
  return projectID;
}

/** Reads an OpenCode 2 session into txcript's common model. txcript cannot read OpenCode 2 sessions itself. */
export async function readOpenCodeSession(sessionId: string, cwd: string) {
  const exported = JSON.parse(await exportSession(sessionId, cwd));
  const messages: Message[] = [];
  for (const message of exported.messages as Record<string, any>[]) {
    const timestamp = new Date(message.time?.created ?? Date.now()).toISOString();
    if (message.type === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: String(message.text ?? "") }], timestamp });
    } else if (message.type === "assistant") {
      const assistant: Block[] = [];
      const results: Block[] = [];
      for (const part of message.content as Record<string, any>[]) {
        if (part.type === "reasoning") assistant.push({ type: "thinking", text: String(part.text) });
        else if (part.type === "text") assistant.push({ type: "text", text: String(part.text) });
        else if (part.type === "tool") {
          assistant.push({ type: "tool_use", id: part.id, tool: { name: "Raw", tool_name: part.name, input: part.state?.input ?? {} } });
          const output = (part.state?.content ?? []).map((c: Block) => (c.type === "text" ? String(c.text) : text(c))).join("\n");
          results.push({ type: "tool_result", tool_use_id: part.id, content: [{ type: "text", text: output || String(part.state?.error ?? "") }], is_error: part.state?.status === "error" });
        }
      }
      if (assistant.length) messages.push({ role: "assistant", content: assistant, timestamp });
      if (results.length) messages.push({ role: "user", content: results, timestamp });
    }
  }
  const info = exported.info;
  return {
    meta: { id: info.id, timestamp: new Date(info.time?.created ?? Date.now()).toISOString(), cwd, title: info.title as string | undefined, model: info.model?.id as string | undefined },
    messages,
  };
}

/**
 * txcript's OpenCode writer targets the older export shape, which OpenCode 2 rejects, so build the
 * OpenCode 2 export here from txcript's common model.
 * ponytail: written from observed exports; cost, token counts and finish reasons are approximate.
 */
export function toOpenCodeExport(
  common: { meta: { title?: string }; messages: Message[] },
  options: { id: string; directory: string; projectID: string; modelId: string },
) {
  const [providerID, ...rest] = options.modelId.includes("/") ? options.modelId.split("/") : ["opencode", options.modelId];
  const model = { id: rest.join("/") || providerID, providerID, variant: "default" };
  const results = new Map<string, string>();
  for (const message of common.messages)
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === "tool_result") results.set(String(block.tool_use_id), resultText(block.content));

  const messages: Record<string, unknown>[] = [];
  for (const message of common.messages) {
    const created = time(message.timestamp);
    const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "user") {
      const body = blocks.filter((b) => b.type === "text" || b.type === "image").map((b) => (b.type === "text" ? String(b.text) : "[image]")).join("\n");
      if (body) messages.push({ id: newId("msg"), metadata: {}, time: { created }, text: body, files: [], type: "user" });
      continue;
    }
    const content = blocks.flatMap((block): Block[] => {
      if (block.type === "thinking") return [{ type: "reasoning", text: String(block.text), state: { reasoningField: "reasoning_content" }, time: { created, completed: created } }];
      if (block.type === "text") return [{ type: "text", text: String(block.text), time: { created, completed: created } }];
      if (block.type === "tool_use") {
        const { name, tool_name: rawName, input: rawInput, ...fields } = block.tool as { name: string; tool_name?: string; input?: unknown };
        const id = String(block.id);
        return [{ type: "tool", id, name: String(rawName ?? name).toLowerCase(), executed: false, state: { status: "completed", input: rawInput ?? fields, content: [{ type: "text", text: results.get(id) ?? "" }] }, time: { created, completed: created } }];
      }
      return [];
    });
    if (content.length === 0) continue;
    messages.push({
      id: newId("msg"),
      time: { created, streamed: created, completed: created },
      type: "assistant",
      agent: "build",
      model,
      content,
      finish: content.some((c) => c.type === "tool") ? "tool-calls" : "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  }
  const now = Date.now();
  return {
    info: {
      id: options.id,
      projectID: options.projectID,
      agent: "build",
      model,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: "succeeded",
      time: { created: time(undefined), updated: now, idle: now },
      title: common.meta.title ?? "Continued session",
      permissions: [],
      location: { directory: options.directory },
    },
    messages,
  };
}

/** Imports the converted session into OpenCode and returns its session id. */
export async function importIntoOpenCode(
  common: { meta: { title?: string }; messages: Message[] },
  cwd: string,
  modelId: string,
) {
  const id = newId("ses");
  const exported = toOpenCodeExport(common, { id, directory: cwd, projectID: await openCodeProjectId(cwd), modelId });
  const dir = await mkdtemp(join(tmpdir(), "switch-provider-"));
  const file = join(dir, `${id}.json`);
  await writeFile(file, JSON.stringify(exported));
  try {
    await run("opencode", ["session", "import", "--directory", cwd, file], { cwd, maxBuffer: 1 << 24 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return id;
}
