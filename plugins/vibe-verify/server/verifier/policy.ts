// Read-only enforcement for verifier agents (ARCHITECTURE 3.6, layer 1): every permission
// request a verifier raises is answered here. Reads and searches are allowed; edits/writes only
// inside the verification output directory; shell commands that look mutating are denied.
// Layer 2 (tree snapshot before/after each round) lives in the pipeline; layer 3 is the MCP:
// VIBE_ROLE=verifier gives vibe-board only read tools and comment.

import path from "node:path";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

export interface PolicyContext {
  /** The only place a verifier may write (verdict/config files, scratch). */
  outputDir: string;
  /** Native task helpers inspect through read/search tools; collectors own shell execution. */
  denyShell?: boolean;
}

const MUTATING_SHELL = [
  /\bgit\s+(add|commit|checkout|switch|reset|restore|clean|stash|merge|rebase|cherry-pick|apply|am|push|pull|rm|mv|tag|branch\s+-[dDmM]|worktree\s+(add|remove|prune))\b/,
  /\b(rm|rmdir|del|erase|mv|move|ren|rename|cp|copy|touch|mkdir|chmod|chown|truncate|tee|dd|ni|sc)\b/i,
  /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
  /\b(Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i,
  /\bnpm\s+(install|i|ci|uninstall|update|publish|version)\b/,
  /\b(pnpm|yarn)\s+(add|install|remove|upgrade)\b/,
  /\bpip3?\s+(install|uninstall)\b/,
  // output redirection (but not 2>&1 / >/dev/null / >NUL)
  /(^|[^&0-9\s>])\s*>{1,2}\s*(?!&|\/dev\/null\b|nul\b|\$null\b)\S/i,
];

export function isMutatingShell(command: string): boolean {
  return MUTATING_SHELL.some((re) => re.test(command));
}

const inside = (dir: string, file: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const deny = (message: string): AgentPermissionResponse => ({ behavior: "deny", message });
const ALLOW: AgentPermissionResponse = { behavior: "allow" };

export function decideVerifierPermission(
  request: AgentPermissionRequest,
  ctx: PolicyContext,
): AgentPermissionResponse {
  const detail = request.detail;
  switch (detail?.type) {
    case "read":
    case "search":
    case "fetch":
      return ALLOW;
    case "edit":
    case "write":
      return inside(ctx.outputDir, detail.filePath)
        ? ALLOW
        : deny(`验证会话为只读；只能在证据目录 ${ctx.outputDir} 内写入。`);
    case "shell":
      return ctx.denyShell || isMutatingShell(detail.command)
        ? deny("验证会话为只读，运行命令交给证据采集器。")
        : ALLOW;
    default:
      break;
  }
  if (request.kind === "question" || request.kind === "plan" || request.kind === "mode") {
    return deny("请依据现有方案与证据完成独立判断；无法判断时报告存疑。");
  }
  // Unknown tool kinds (e.g. MCP tools): allow only the board's read/comment tools.
  return /vibe_(projects|list|show|comment)\b/.test(request.name)
    ? ALLOW
    : deny("验证会话为只读，禁止使用此工具。");
}

/** Restored native helper tabs remain read-only after their verification has ended. */
export function restoredVerifierPolicy(
  session:
    | { id: string; cardId: string | null; workspaceId: string | null; role: string }
    | undefined,
  root: string,
): PolicyContext | undefined {
  if (
    !session?.workspaceId ||
    session.cardId !== null ||
    !["reviewer", "verifier"].includes(session.role)
  )
    return;
  return { outputDir: path.join(root, "readonly", session.id), denyShell: true };
}
