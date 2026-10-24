import { defaultPromptPort, type PromptPort } from "../prompts/port";
import type { Project } from "../vibe/contract";
import { readRequirementsDoc } from "../vibe/db";

export const DEFAULT_REQUIREMENTS_CHARS = 6000;

/** The requirements document as an excerpt block; `truncated` tells the master it must not rewrite it. */
export function requirementsExcerpt(
  project: Pick<Project, "repoPath" | "requirementsPath">,
  maxChars: number,
): { text: string; truncated: boolean } | null {
  if (maxChars <= 0 || !project.repoPath) return null;
  try {
    const doc = readRequirementsDoc(project.repoPath, project.requirementsPath);
    if (!doc.exists || !doc.content.trim()) return null;
    const content = doc.content.replace(/\r\n/g, "\n").trim();
    const truncated = content.length > maxChars;
    const body = truncated
      ? `${content.slice(0, maxChars)}\n[…… 已截断：还有 ${content.length - maxChars} 个字符，完整文件见 ${doc.path}]`
      : content;
    return {
      text: `需求文档（${doc.path}${truncated ? "，TRUNCATED" : "，完整"}）：\n${body}`,
      truncated,
    };
  } catch {
    return null;
  }
}

export function buildRepairMessage(
  kind: string,
  error: string,
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.repair_json", { projectId, vars: { kind, error } });
}
