import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Block = { type: string; [key: string]: unknown };
export type Message = { role: string; content: string | Block[]; timestamp?: string };
export type Common = { meta: Record<string, unknown>; messages: Message[] };

const KEEP_TURNS = 10;
const TRANSCRIPT_BLOCK_CAP = 20_000;
// ponytail: characters per token is a rough average for English and code; a real tokenizer would be tighter.
const tokens = (chars: number) => Math.ceil(chars / 4);

const blocks = (message: Message): Block[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const clip = (text: string, cap: number) => (text.length > cap ? `${text.slice(0, cap)}… [cut ${text.length - cap} characters]` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return asText(content ?? "");
  return content.map((part: Block) => (part.type === "text" ? String(part.text) : part.type === "image" ? "[image]" : asText(part))).join("\n");
}

function toolInfo(block: Block) {
  const { name, tool_name: rawName, input, ...fields } = block.tool as { name: string; tool_name?: string; input?: unknown };
  return { name: String(rawName ?? name), input: input ?? fields };
}

/** A turn starts at a user message that carries text, not only tool results. */
const startsTurn = (message: Message) => message.role === "user" && blocks(message).some((b) => b.type === "text" && String(b.text).trim());

function size(message: Message) {
  return blocks(message).reduce((sum, b) => sum + asText(b.text ?? b.input ?? b.tool ?? b.content ?? "").length, 0);
}

export const estimateTokens = (common: Common) => tokens(common.messages.reduce((sum, m) => sum + size(m), 0));

function resultMap(common: Common) {
  const results = new Map<string, { text: string; error: boolean }>();
  for (const m of common.messages)
    for (const b of blocks(m))
      if (b.type === "tool_result") results.set(String(b.tool_use_id), { text: resultText(b.content), error: Boolean(b.is_error) });
  return results;
}

/** The complete conversation as Markdown, plus the line range each block of each message occupies. */
function transcript(common: Common) {
  const lines: string[] = ["# Detailed transcript (long tool blocks may be cut)", ""];
  const ranges: [number, number][][] = [];
  const results = resultMap(common);
  common.messages.forEach((message, index) => {
    const perBlock: [number, number][] = [];
    for (const b of blocks(message)) {
      const start = lines.length + 1;
      if (b.type === "text") lines.push(`## ${message.role === "user" ? "User" : "Assistant"} (message ${index + 1})`, "", ...String(b.text).split("\n"), "");
      else if (b.type === "image") lines.push("[image omitted]", "");
      else if (b.type === "tool_use") {
        const { name, input } = toolInfo(b);
        const result = results.get(String(b.id));
        lines.push(`### Tool call: ${name}`, "", ...clip(asText(input), TRANSCRIPT_BLOCK_CAP).split("\n"), "");
        lines.push(`### Tool result${result?.error ? " (error)" : ""}`, "", ...clip(result?.text ?? "", TRANSCRIPT_BLOCK_CAP).split("\n"), "");
      }
      perBlock.push([start, lines.length]);
    }
    ranges.push(perBlock);
  });
  return { text: lines.join("\n"), ranges };
}


const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "applypatch", "str_replace_editor", "str_replace_based_edit_tool"]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "execute", "run_command", "command"]);
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"];

const LIST_CAP = 40;

// A plausible file path. Shell edits are found with regular expressions, which also catch words like "10px" or
// "node:fs", so require a slash or an extension, and drop /tmp and dot-prefixed scratch scripts.
function relevantPath(path: string): boolean {
  const value = path.trim();
  if (!/^[\w./~@+-][^\s"'`$*?<>|(){}:;]*$/.test(value) || value.startsWith("/tmp/")) return false;
  if (!value.includes("/") && !/\.\w{1,8}$/.test(value)) return false;
  return !/(^|\/)\.[^/]+\.(?:m?js|tsx?)$/.test(value) && !/\.tmp\.[^/]+$/.test(value);
}

function shellEditedPaths(command: string): string[] {
  const paths = new Set<string>();
  for (const match of command.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/g)) paths.add(match[1].trim());
  for (const match of command.matchAll(/\b(?:cat|tee)\s*>\s*(['"]?)([^\s'";&|]+)\1/g)) paths.add(match[2]);
  for (const match of command.matchAll(/\bsed\s+-i(?:\s+[^\n;]+?)?\s+(['"]?)([^\s'";&|]+)\1(?=\s*(?:;|&&|\n|$))/g)) paths.add(match[2]);
  // Many coding agents use a short Python script to edit a file. Record only paths passed to a write call.
  for (const match of command.matchAll(/\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])[wax][^'"]*\3/g)) paths.add(match[2]);
  const variablePaths = new Map<string, string>();
  for (const match of command.matchAll(/(?:^|\n)\s*([A-Za-z_]\w*)\s*=\s*(['"])([^'"\n]+)\2/g)) variablePaths.set(match[1], match[3]);
  for (const match of command.matchAll(/\bopen\(\s*([A-Za-z_]\w*)\s*,\s*(['"])[wax][^'"]*\2/g)) {
    const path = variablePaths.get(match[1]);
    if (path) paths.add(path);
  }
  return [...paths];
}

function shellCommandLines(command: string): string {
  let endMarker: string | undefined;
  return command.split("\n").filter((line) => {
    if (endMarker) {
      if (line.trim() === endMarker) endMarker = undefined;
      return false;
    }
    const marker = line.match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (marker) endMarker = marker[1];
    return true;
  }).join("\n");
}

/**
 * Facts that older history would otherwise bury: the goal, files edited, commits made and unfinished tasks.
 * Built only from tool calls and text, so it is deterministic.
 */
function sections(common: Common, ranges: [number, number][][]) {
  const results = resultMap(common);
  const files = new Map<string, { edits: number; pointer: string }>();
  const commits: string[] = [];
  let todos: string[] = [];
  common.messages.forEach((message, i) =>
    blocks(message).forEach((b, j) => {
      if (b.type !== "tool_use") return;
      const [from, to] = ranges[i][j];
      const pointer = `[L${from}-L${to}]`;
      const { name, input } = toolInfo(b);
      const tool = name.toLowerCase();
      const failed = results.get(String(b.id))?.error;
      if (EDIT_TOOLS.has(tool) && !failed) {
        const raw = asText(input);
        const paths = new Set<string>();
        for (const key of PATH_KEYS) {
          const value = (input as Record<string, unknown>)?.[key];
          if (typeof value === "string") paths.add(value);
        }
        for (const match of raw.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g)) paths.add(match[1].trim());
        for (const path of paths) if (relevantPath(path)) files.set(path, { edits: (files.get(path)?.edits ?? 0) + 1, pointer });
      } else if (SHELL_TOOLS.has(tool) && !failed) {
        const command = asText((input as Record<string, unknown>)?.command ?? input);
        for (const path of shellEditedPaths(command)) if (relevantPath(path)) files.set(path, { edits: (files.get(path)?.edits ?? 0) + 1, pointer });
        const executable = shellCommandLines(command);
        if (/(^|[;&|\n]\s*)git(?:\s+-C\s+\S+)?\s+commit\b/.test(executable)) {
          const quoted = executable.match(/\bgit(?:\s+-C\s+\S+)?\s+commit\b[^\n]*?-m\s+(?:"([^"\\]+)|'([^'\\]+))/);
          // Claude Code writes the message as -m "$(cat <<'EOF' ... EOF)", so read the first line of that body.
          const heredoc = command.match(/\bcommit\b[^\n]*<<-?\s*['"]?[A-Za-z_]\w*['"]?\s*\n\s*([^\n]+)/);
          const message = quoted?.[1]?.startsWith("$(") ? heredoc?.[1] : (quoted?.[1] ?? quoted?.[2] ?? heredoc?.[1]);
          commits.push(`- ${clip(oneLine((message ?? "git commit").split("\n")[0]), 140)} ${pointer}`);
        }
      } else if (tool === "todowrite" || tool === "update_plan") {
        const list = (input as Record<string, unknown>)?.todos ?? (input as Record<string, unknown>)?.plan;
        if (Array.isArray(list))
          todos = list
            .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).status !== "completed")
            .map((item) => `- ${clip(String((item as Record<string, unknown>).content ?? (item as Record<string, unknown>).step ?? ""), 200)}`);
      }
    }),
  );
  const first = common.messages.find(startsTurn);
  const goal = first ? clip(blocks(first).filter((b) => b.type === "text").map((b) => String(b.text)).join(" ").trim(), 600) : "";
  const recent = [...files.entries()].slice(-LIST_CAP).reverse();
  const out: string[] = [];
  if (goal) out.push(`Session goal: ${goal}`, "");
  if (recent.length) out.push(`Files edited (${files.size} detected, newest first):`, ...recent.map(([path, f]) => `- ${path} (${f.edits} edit${f.edits === 1 ? "" : "s"}) ${f.pointer}`), "");
  if (commits.length) out.push(`Commits (${commits.length}):`, ...commits.slice(-LIST_CAP), "");
  if (todos.length) out.push("Unfinished tasks from the last task list:", ...todos.slice(0, LIST_CAP), "");
  return out.join("\n");
}

/** One deterministic summary line per message, each pointing at its lines in the full transcript. */
function brief(common: Common, count: number, ranges: [number, number][][], textCap: number, resultCap: number) {
  const results = resultMap(common);
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    const message = common.messages[i];
    blocks(message).forEach((b, j) => {
      const [from, to] = ranges[i][j];
      const pointer = `[L${from}-L${to}]`;
      if (b.type === "text" && String(b.text).trim())
        entries.push(`- ${pointer} ${message.role === "user" ? "User" : "Assistant"}: ${clip(String(b.text).trim(), textCap)}`);
      else if (b.type === "tool_use") {
        const { name, input } = toolInfo(b);
        const result = results.get(String(b.id));
        const outcome = result?.error ? `ERROR: ${clip(result.text, 2000)}` : result ? `ok: ${clip(oneLine(result.text), resultCap)}` : "no result";
        entries.push(`- ${pointer} ${name}(${clip(oneLine(asText(input)), 160)}) -> ${outcome}`);
      }
    });
  }
  return entries;
}

/** Copy a message without reasoning, which carries provider-specific signatures, and without images. */
function plain(message: Message): Message | null {
  const kept = blocks(message)
    .filter((b) => b.type !== "thinking")
    .map((b) => (b.type === "image" ? { type: "text", text: "[image omitted]" } : b));
  return kept.length ? { ...message, content: kept } : null;
}

export type Compaction = { common: Common; transcriptPath: string; beforeTokens: number; afterTokens: number };

/**
 * Keeps the last few turns word for word and replaces everything before them with a short, deterministic
 * view that points into a full transcript file. Returns null when the session already fits `budget` tokens.
 */
export async function compact(common: Common, budget: number): Promise<Compaction | null> {
  const beforeTokens = estimateTokens(common);
  if (beforeTokens <= budget) return null;

  const { text, ranges } = transcript(common);
  const dir = join(tmpdir(), "paseo-transcripts");
  await mkdir(dir, { recursive: true });
  const transcriptPath = join(dir, `${String(common.meta.id ?? Date.now())}.md`);
  await writeFile(transcriptPath, `${text}\n`);

  const turnStarts = common.messages.flatMap((m, i) => (startsTurn(m) ? [i] : []));
  // The first line becomes the new agent's title, so name it after the original opening request.
  const opening = oneLine(blocks(common.messages[turnStarts[0] ?? 0] ?? { role: "user", content: "" }).map((b) => String(b.text ?? "")).join(" "));
  const header = [
    `${clip(opening, 70) || "Continued session"}`,
    "",
    "This session moved to a new provider and its history was too large for the new model's context window.",
    "Earlier history is compacted below: your messages and the assistant's text are kept, tool calls are one line each, and errors are kept in full.",
    `The detailed transcript is at ${transcriptPath}. Each entry's [L<first>-L<last>] pointer gives its line range there. Read or search those lines when you need more detail. Long tool blocks may be cut; images and reasoning are omitted.`,
    "Do not resume, repeat or finish earlier work on your own. Wait for the user's next message and answer only that.",
    "",
  ].join("\n");

  const facts = sections(common, ranges);
  const stamp = common.messages[0]?.timestamp ?? new Date().toISOString();
  const attempt = (turns: number, textCap: number, resultCap: number, dropOldest: number) => {
    const cut = turnStarts.length > turns ? turnStarts[turnStarts.length - turns] : 0;
    const entries = brief(common, cut, ranges, textCap, resultCap).slice(dropOldest);
    const tail = common.messages.slice(cut).map(plain).filter((m): m is Message => m !== null);
    const summary: Message[] = entries.length
      ? [
          { role: "user", content: [{ type: "text", text: `${header}${facts}\nEarlier history, oldest first:\n${entries.join("\n")}` }], timestamp: stamp },
          { role: "assistant", content: [{ type: "text", text: "Understood. I will use the compacted history and the full transcript when I need details." }], timestamp: stamp },
        ]
      : [];
    const next: Common = { meta: common.meta, messages: [...summary, ...tail] };
    return { next, afterTokens: estimateTokens(next) };
  };

  for (const turns of [KEEP_TURNS, 6, 3, 1])
    for (const [textCap, resultCap] of [[2000, 200], [800, 100], [300, 0]] as const) {
      const result = attempt(turns, textCap, resultCap, 0);
      if (result.afterTokens <= budget) return { common: result.next, transcriptPath, beforeTokens, afterTokens: result.afterTokens };
    }
  // Still too big: drop the oldest compacted lines, keeping the newest.
  const total = brief(common, turnStarts.length > 1 ? turnStarts[turnStarts.length - 1] : 0, ranges, 300, 0).length;
  for (let drop = Math.ceil(total / 4); drop <= total; drop += Math.ceil(total / 4)) {
    const result = attempt(1, 300, 0, drop);
    if (result.afterTokens <= budget || drop >= total) return { common: result.next, transcriptPath, beforeTokens, afterTokens: result.afterTokens };
  }
  return null;
}
