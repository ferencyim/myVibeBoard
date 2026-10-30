// Keeps a marker block in the global agent instruction files (~/.claude/CLAUDE.md,
// ~/.codex/AGENTS.md) in step with the active hub directives, for sessions outside myVibeBoard.
// Only the bytes between the markers are ever replaced; a missing file is never created.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { directiveApplies, type Directive } from "./vibe/db";

export const BLOCK_BEGIN = "<!-- vibe-hub:directives:begin -->";
export const BLOCK_END = "<!-- vibe-hub:directives:end -->";

export interface DirectiveFileTarget {
  path: string;
  /** Provider id whose provider-scoped directives belong in this file. */
  provider: string;
}

export function defaultDirectiveFiles(env: NodeJS.ProcessEnv = process.env): DirectiveFileTarget[] {
  return [
    { path: env.VIBE_HUB_CLAUDE_MD || join(homedir(), ".claude", "CLAUDE.md"), provider: "claude" },
    { path: env.VIBE_HUB_AGENTS_MD || join(homedir(), ".codex", "AGENTS.md"), provider: "codex" },
  ];
}

export function renderBlockBody(directives: readonly Directive[]): string {
  if (!directives.length) return "暂无";
  return [
    "以下是 myVibeBoard 资源中枢下发的全局指令（由系统维护，请勿手改此块）：",
    ...directives.map(
      (d) =>
        `- ${d.text.trim().replace(/\s*\n\s*/g, " ")}${d.expiresAt ? `（到期：${d.expiresAt}）` : ""}`,
    ),
  ].join("\n");
}

/** Pure text transform. Returns null when the file has a broken marker pair and must be left alone. */
export function applyBlock(content: string, body: string): string | null {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const block = [BLOCK_BEGIN, ...body.split("\n"), BLOCK_END].join(eol);
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin < 0) {
    if (content.includes(BLOCK_END)) return null;
    if (!content.length) return `${block}${eol}`;
    const lead = content.endsWith("\n") ? "" : eol;
    return `${content}${lead}${eol}${block}${eol}`;
  }
  const end = content.indexOf(BLOCK_END, begin + BLOCK_BEGIN.length);
  if (end < 0) return null;
  return content.slice(0, begin) + block + content.slice(end + BLOCK_END.length);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.vibe-hub-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file may not exist
    }
    throw error;
  }
}

/** Directives that belong in a file for `provider`: scope all or that provider. */
export function directivesForFile(all: readonly Directive[], provider: string): Directive[] {
  return all.filter((d) => d.scope.kind !== "projects" && directiveApplies(d.scope, { provider }));
}

export function syncDirectiveFiles(
  targets: readonly DirectiveFileTarget[],
  active: readonly Directive[],
  log: (message: string) => void = () => {},
): void {
  for (const target of targets) {
    try {
      if (!existsSync(target.path)) {
        log(`vibe-scheduler: 全局指令文件不存在，跳过（不创建）：${target.path}`);
        continue;
      }
      const current = readFileSync(target.path, "utf8");
      const next = applyBlock(current, renderBlockBody(directivesForFile(active, target.provider)));
      if (next === null) log(`vibe-scheduler: 全局指令标记块不完整，跳过：${target.path}`);
      else if (next !== current) writeAtomic(target.path, next);
    } catch (error) {
      log(`vibe-scheduler: 同步全局指令文件失败 ${target.path}：${String(error)}`);
    }
  }
}
