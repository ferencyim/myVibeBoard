import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Structured, model-free handoff of one task tab. Everything here is derived, never generated. */
const Checkpoint = z.object({
  worktree: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  dirtyHash: z.string().nullable(),
  changedPaths: z.array(z.string()),
});
export const HandoffPacketSchema = z.object({
  fromTab: z.object({
    number: z.number(),
    agentId: z.string(),
    role: z.string(),
    model: z.string(),
  }),
  phase: z.string(),
  planGoal: z.string(),
  checkpoint: Checkpoint.nullable(),
  lastOutput: z.string(),
  openItems: z.array(z.string()),
  nextSteps: z.array(z.string()),
  createdAt: z.string(),
});
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;
export type HandoffCheckpoint = z.infer<typeof Checkpoint>;

const MAX_CHANGED_PATHS = 50;
const MAX_STAMPED_FILES = 200;
const MAX_ITEMS = 10;
const MAX_ITEM_CHARS = 300;
const MAX_LAST_OUTPUT = 6000;
export const MAX_HISTORY_CHARS = 30_000;
const FENCE_OPEN = "<<<VIBE-HISTORY-BEGIN>>>";
const FENCE_CLOSE = "<<<VIBE-HISTORY-END>>>";

export function git(cwd: string, args: string[], timeout = 15_000): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => done(error ? undefined : String(stdout)),
    );
  });
}

/** Read-only snapshot of the worktree; null when it is not a git checkout. */
export async function captureCheckpoint(worktree: string): Promise<HandoffCheckpoint | null> {
  const head = (await git(worktree, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return null;
  const branch = (await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || null;
  const status = (await git(worktree, ["status", "--porcelain"])) ?? "";
  const paths = new Set<string>();
  for (const base of ["main", "master"]) {
    const mergeBase = (await git(worktree, ["merge-base", "HEAD", base]))?.trim();
    if (!mergeBase) continue;
    const diff = (await git(worktree, ["diff", "--name-only", mergeBase, "HEAD"])) ?? "";
    for (const line of diff.split("\n")) if (line.trim()) paths.add(line.trim());
    break;
  }
  // `status --porcelain` only names dirty files; size and mtime catch a second edit of one.
  const stampPaths: string[] = [];
  for (const line of status.split("\n")) {
    // "XY path" or "XY old -> new"
    const path = line.slice(3).split(" -> ").at(-1)?.trim().replace(/^"|"$/g, "");
    if (!path) continue;
    paths.add(path);
    if (stampPaths.length < MAX_STAMPED_FILES) stampPaths.push(path);
  }
  const stamps = await Promise.all(stampPaths.map(async (path) => {
    try {
      const info = await stat(join(worktree, path));
      return `${path}:${info.size}:${Math.trunc(info.mtimeMs)}`;
    } catch {
      return path + ":gone";
    }
  }));
  return {
    worktree,
    head,
    branch: branch === "HEAD" ? null : branch,
    dirtyHash: status ? createHash("sha1").update(status + stamps.join("\n")).digest("hex") : "",
    changedPaths: [...paths].slice(0, MAX_CHANGED_PATHS),
  };
}

const HEADING = /^\s*(?:#{1,6}\s*|\*\*|__)?\s*(未决问题|下一步)\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*|__)?\s*$/;
const ANY_HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*[:：]?\s*$)/;
const EMPTY_ITEM = /^[（(]?\s*(无|没有|暂无|none|n\/a)\s*[)）]?[。.]?$/i;

/** Pull the agreed「未决问题」「下一步」sections from the last turn's text; failure yields []. */
export function parseSections(text: string): { openItems: string[]; nextSteps: string[] } {
  const result = { openItems: [] as string[], nextSteps: [] as string[] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i]!);
    if (!match) continue;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (HEADING.test(line) || ANY_HEADING.test(line)) break;
      const item = line.replace(/^\s*(?:[-*+•]|\d+[.、)])\s*/, "").trim();
      if (!item || EMPTY_ITEM.test(item)) continue;
      items.push(item.slice(0, MAX_ITEM_CHARS));
    }
    // The last occurrence wins: earlier turns of the same reply may quote the headings.
    result[match[1] === "未决问题" ? "openItems" : "nextSteps"] = items.slice(0, MAX_ITEMS);
  }
  return result;
}

export function buildPacket(input: {
  fromTab: HandoffPacket["fromTab"];
  phase: string;
  planGoal: string;
  checkpoint: HandoffCheckpoint | null;
  output: string;
  now: Date;
}): HandoffPacket {
  const output = input.output.trim();
  return {
    fromTab: input.fromTab,
    phase: input.phase,
    planGoal: input.planGoal,
    checkpoint: input.checkpoint,
    lastOutput: output.length > MAX_LAST_OUTPUT ? output.slice(-MAX_LAST_OUTPUT) : output,
    ...parseSections(output),
    createdAt: input.now.toISOString(),
  };
}

/** Why the repo no longer matches the packet's checkpoint; undefined when nothing changed. */
export function checkpointDrift(
  saved: HandoffCheckpoint | null,
  current: HandoffCheckpoint | null,
): string | undefined {
  if (!saved || !current) return undefined;
  const parts: string[] = [];
  if (saved.head !== current.head)
    parts.push(`HEAD ${saved.head?.slice(0, 8) ?? "无"} → ${current.head?.slice(0, 8) ?? "无"}`);
  if (saved.dirtyHash !== current.dirtyHash) parts.push("未提交改动已变化");
  return parts.length ? parts.join("；") : undefined;
}

/** Quoted history must not be able to close the fence early. */
export function escapeFence(text: string): string {
  return text.replace(/<<<(\s*)VIBE-HISTORY/gi, "<<​<$1VIBE-HISTORY");
}

/** Executable items first, the raw last output last. Sections are cut whole-first, then by size. */
export function renderHandoff(
  packet: HandoffPacket,
  options: { notice: string; drift?: string; maxChars?: number },
): string {
  const { fromTab, checkpoint } = packet;
  const sections: Array<[string, string]> = [];
  if (packet.openItems.length)
    sections.push(["未决问题", packet.openItems.map((item) => "- " + item).join("\n")]);
  if (packet.nextSteps.length)
    sections.push(["下一步", packet.nextSteps.map((item) => "- " + item).join("\n")]);
  if (checkpoint?.changedPaths.length)
    sections.push(["改动文件", checkpoint.changedPaths.map((path) => "- " + path).join("\n")]);
  if (checkpoint)
    sections.push([
      "检查点",
      [
        `工作目录：${checkpoint.worktree}`,
        `分支：${checkpoint.branch ?? "（游离 HEAD）"}`,
        `HEAD：${checkpoint.head ?? "无"}`,
        `未提交改动：${checkpoint.dirtyHash ? "有（" + checkpoint.dirtyHash.slice(0, 8) + "）" : "无"}`,
      ].join("\n"),
    ]);
  if (packet.lastOutput) sections.push([`#${fromTab.number} 最近输出`, packet.lastOutput]);
  let budget = options.maxChars ?? MAX_HISTORY_CHARS;
  const body: string[] = [];
  let truncated = false;
  for (const [title, text] of sections) {
    const block = `【${title}】\n${escapeFence(text)}`;
    if (block.length <= budget) {
      body.push(block);
      budget -= block.length + 2;
    } else {
      if (budget > 200) body.push(block.slice(0, budget));
      truncated = true;
      break;
    }
  }
  if (truncated) body.push("（以上内容已截断）");
  return [
    `#${fromTab.number} 交接包（${fromTab.role}，${fromTab.model}；阶段 ${packet.phase}；${packet.createdAt}）`,
    packet.planGoal ? `确认方案目标：${packet.planGoal}` : "",
    options.drift ? `注意：#${fromTab.number} 交接之后仓库已变化：${options.drift}。请先核对再继续。` : "",
    options.notice,
    FENCE_OPEN,
    body.join("\n\n"),
    FENCE_CLOSE,
  ]
    .filter(Boolean)
    .join("\n");
}
