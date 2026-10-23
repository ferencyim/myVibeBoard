// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Reuse the retained project row as the extension of a native Paseo project.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Project } from "../contract/model";

export function canonicalProjectPath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    canonical = resolve(path);
  }
  canonical = canonical.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Exact native ID wins; an unlinked row may be adopted by its real repository identity. */
export function findProjectConfig(
  projects: readonly Project[],
  paseoProjectId: string,
  repoPath?: string,
): Project | undefined {
  if (!paseoProjectId.trim()) throw new Error("原生 projectId 不能为空");
  const linked = projects.filter((p) => p.paseoProjectId === paseoProjectId);
  if (linked.length > 1) throw new Error("项目配置关联有歧义：" + paseoProjectId);
  if (linked.length === 1) return linked[0];
  if (!repoPath) return undefined;
  const path = canonicalProjectPath(repoPath);
  const candidates = projects.filter((p) => canonicalProjectPath(p.repoPath) === path);
  if (candidates.length > 1) throw new Error("项目仓库路径有歧义：" + repoPath);
  const match = candidates[0];
  if (match?.paseoProjectId && match.paseoProjectId !== paseoProjectId)
    throw new Error("项目仓库已经关联其它原生 projectId：" + match.paseoProjectId);
  return match;
}
