// Auto-approval for one narrow permission class: a worker writing its own progress notes
// (`<worktree>/.vibe/sessions/*.md`, vibe-context compaction asks for them before /compact).
// Everything else still waits for the user.
//
// Paths come from the request (`detail.filePath`, `input.file_path|path`) or, for providers whose
// approval request carries no path (codex "CodexFileChange"), from the matching tool-call item in
// the agent's timeline (`metadata.itemId` = tool-call id). Every path must resolve inside the
// sessions directory; a request without any resolvable path is never approved.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";

interface RequestLike {
  id: string;
  kind: string;
  input?: unknown;
  detail?: unknown;
  metadata?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

/** True when `file` (absolute or relative to `root`) is a file directly or nested under root/.vibe/sessions. */
export function isSessionNotePath(root: string, file: string): boolean {
  const dir = resolve(root, ".vibe", "sessions");
  const target = resolve(root, file);
  const rel = relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

function directPaths(request: RequestLike): string[] {
  const out: string[] = [];
  const detail = asRecord(request.detail);
  if (detail && (detail.type === "write" || detail.type === "edit") && typeof detail.filePath === "string") {
    out.push(detail.filePath);
  }
  const input = asRecord(request.input);
  for (const key of ["file_path", "filePath", "path"]) {
    if (typeof input?.[key] === "string") out.push(input[key] as string);
  }
  return out;
}

/** Cheap synchronous pre-check: does the request carry (or point to) any file path at all? */
export function mayWriteFile(request: RequestLike): boolean {
  return (
    request.kind === "tool" &&
    (directPaths(request).length > 0 || typeof asRecord(request.metadata)?.itemId === "string")
  );
}

async function timelinePaths(paseo: PaseoApi, agentId: string, itemId: string): Promise<string[]> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 });
  const out: string[] = [];
  for (const entry of page.entries) {
    const item = asRecord(entry.item);
    if (item?.type !== "tool_call" || item.callId !== itemId) continue;
    const detail = asRecord(item.detail);
    if (typeof detail?.filePath === "string") out.push(detail.filePath);
  }
  return out;
}

/** Approve the request when it only writes session notes under one of `roots`. Returns true if approved. */
export async function approveSessionNoteWrite(options: {
  paseo: PaseoApi;
  agentId: string;
  request: RequestLike;
  roots: string[];
}): Promise<boolean> {
  const { paseo, agentId, request } = options;
  if (request.kind !== "tool") return false;
  let paths = directPaths(request);
  const itemId = asRecord(request.metadata)?.itemId;
  if (paths.length === 0 && typeof itemId === "string") {
    paths = await timelinePaths(paseo, agentId, itemId);
  }
  if (paths.length === 0) return false;
  const roots = options.roots.filter(Boolean);
  const allowed = paths.every((p) => roots.some((root) => isSessionNotePath(root, p)));
  if (!allowed) return false;
  await paseo.agents
    .ref(agentId)
    .respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  return true;
}
