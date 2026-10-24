// Verification tabs must only read the workspace. Any file-editing tool call or Git-state
// command in their timeline invalidates the round, even when the end snapshot looks unchanged.

import path from "node:path";

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "apply_patch",
  "applypatch",
  "patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "create_file",
  "write_file",
  "delete_file",
  "file_edit",
  "edit_file",
  "replace_in_file",
]);
const EDIT_DETAIL_TYPES = new Set(["edit", "write"]);
const GIT_MUTATIONS = new Set([
  "commit",
  "reset",
  "checkout",
  "restore",
  "stash",
  "clean",
  "merge",
  "rebase",
  "push",
  "update-ref",
]);

export interface TimelineViolation {
  kind: "edit" | "git";
  summary: string;
  paths: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function nonEmpty(value: unknown): string[] {
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}
function patchPaths(text: string): string[] {
  return [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}
function pathsOf(detail: Record<string, unknown>): string[] {
  const direct = [
    detail.filePath,
    detail.file_path,
    detail.path,
    detail.filename,
    detail.file,
  ].flatMap(nonEmpty);
  if (direct.length) return direct;
  const input = record(detail.input);
  if (input) {
    const nested = [
      input.filePath,
      input.file_path,
      input.path,
      input.filename,
      input.file,
    ].flatMap(nonEmpty);
    if (nested.length) return nested;
    return [input.patch, input.input, input.text].flatMap((value) =>
      nonEmpty(value).flatMap(patchPaths),
    );
  }
  return nonEmpty(detail.input).flatMap(patchPaths);
}
function unquote(token: string): string {
  if (token.length >= 2 && /^(['"]).*\1$/.test(token)) return token.slice(1, -1);
  return token;
}
function tokensOf(segment: string): string[] {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(unquote);
}
/** Detects a Git command that changes refs/history even when it is chained or prefixed. */
export function gitMutation(command: string): string | undefined {
  for (const segment of command.split(/\s*(?:&&|\|\||[;|\n])\s*/)) {
    const tokens = tokensOf(segment);
    for (let index = 0; index < tokens.length; index++) {
      if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[index]!)) continue;
      let cursor = index + 1;
      while (cursor < tokens.length) {
        const token = tokens[cursor]!;
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(token)) {
          cursor += 2;
          continue;
        }
        if (token.startsWith("-")) {
          cursor++;
          continue;
        }
        break;
      }
      const subcommand = tokens[cursor]?.toLowerCase();
      if (!subcommand) return undefined;
      if (subcommand === "stash") {
        // Listing or showing stashes only reads them; anything else (push/save/pop/apply/drop/
        // clear/branch/create, or the implicit save of a bare `git stash`) mutates the repo.
        const rest = tokens.slice(cursor + 1);
        const action = rest.find((token) => !token.startsWith("-"))?.toLowerCase();
        return action === "list" || action === "show" ? undefined : "stash";
      }
      if (GIT_MUTATIONS.has(subcommand)) return subcommand;
      if (
        subcommand === "branch" &&
        tokens.slice(cursor + 1).some((token) => /^(?:-f|--force|-D)$/i.test(token))
      )
        return "branch -f";
      return undefined;
    }
  }
  return undefined;
}
function excerpt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 200 ? single.slice(0, 200) + "…" : single;
}

/**
 * Scans timeline entries for tool calls that edit files or mutate Git. Edited paths outside the
 * worktree (evidence output, temp directories) are not repository edits; inside paths that are
 * ignored by `.gitignore` are dropped (test artifacts change constantly); a call with no path we
 * can check stays a violation. An entry is left out only when its timestamp proves it predates the
 * round start; undated entries stay in scope.
 */
export interface TimelineScanOptions {
  /** Worktree root; edit paths outside it do not belong to this repository. */
  root?: string;
  /** Verification start instant; earlier entries are not part of this round. */
  since?: string;
  ignored?: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
}

function entryTime(entry: unknown): number | undefined {
  const value = record(entry)?.timestamp;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

export async function timelineViolations(
  entries: readonly unknown[],
  options: TimelineScanOptions = {},
): Promise<TimelineViolation[]> {
  const violations: TimelineViolation[] = [];
  const edits: Array<{ summary: string; paths: string[]; inside: Map<string, string> }> = [];
  const root = options.root ? path.resolve(options.root) : undefined;
  const since = options.since ? Date.parse(options.since) : undefined;
  for (const entry of entries) {
    const time = entryTime(entry);
    if (since !== undefined && Number.isFinite(since) && time !== undefined && time <= since)
      continue;
    const envelope = record(entry);
    const item = record(envelope?.item) ?? envelope;
    if (!item || item.type !== "tool_call") continue;
    const detail = record(item.detail);
    if (!detail) continue;
    const tool = String(item.name ?? "");
    if (detail.type === "shell" && typeof detail.command === "string") {
      const mutation = gitMutation(detail.command);
      if (mutation)
        violations.push({
          kind: "git",
          summary: `${tool || "shell"} 改变了 Git 状态（${mutation}）：${excerpt(detail.command)}`,
          paths: [],
        });
    }
    if (EDIT_DETAIL_TYPES.has(String(detail.type)) || EDIT_TOOL_NAMES.has(tool.toLowerCase())) {
      const paths = pathsOf(detail);
      const inside = new Map<string, string>();
      for (const raw of paths) {
        if (!root) {
          inside.set(raw, raw);
          continue;
        }
        const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
        if (!within(root, absolute)) continue;
        const relative = path.relative(root, absolute);
        inside.set(raw, relative ? relative.split(path.sep).join("/") : ".");
      }
      edits.push({
        summary: `${tool || String(detail.type)} 修改文件${paths.length ? "：" + paths.join("、") : ""}`,
        paths,
        inside,
      });
    }
  }
  if (!edits.length) return violations;
  const allPaths = [...new Set(edits.flatMap((edit) => [...edit.inside.values()]))];
  const ignored = options.ignored && allPaths.length ? await options.ignored(allPaths) : new Set();
  for (const edit of edits) {
    const remaining = edit.paths.filter((raw) => {
      const relative = edit.inside.get(raw);
      return relative !== undefined && !ignored.has(relative);
    });
    if (edit.paths.length && !remaining.length) continue;
    violations.push({ kind: "edit", summary: edit.summary, paths: remaining });
  }
  return violations;
}
