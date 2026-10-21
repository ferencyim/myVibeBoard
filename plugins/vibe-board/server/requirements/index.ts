// Project requirements document RPCs and the manual "ask master to review" trigger.

import { BoardError, type BoardService } from "../service";
import {
  RequirementsDocError,
  execGit,
  publishEvent,
  readRequirementsDoc,
  writeRequirementsDoc,
  type GitRunner,
  type VibeDb,
} from "../vibe/db";

export const REQUIREMENTS_COMMIT_MESSAGE = "docs: update product requirements (myVibeBoard)";

/** RequirementsDocError -> board error with a user-facing Chinese message. */
export function toRequirementsError(error: unknown): Error {
  if (!(error instanceof RequirementsDocError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.code) {
    case "repo_busy":
      return new BoardError("conflict", "仓库正在合并、变基或拣选中，稍后再保存");
    case "invalid_path":
      return new BoardError("invalid", "需求文档路径必须是仓库内的相对路径（不能含 ..）");
    case "ignored":
      return new BoardError("invalid", "需求文档被 .gitignore 忽略，无法提交；请换一个路径");
    default:
      return new BoardError("conflict", `Git 操作失败：${error.message}`);
  }
}

export function createRequirementsService(opts: { board: BoardService; db: VibeDb; git?: GitRunner }) {
  const { board, db, git = execGit } = opts;

  function repoOf(ref: string) {
    const project = board.projects.resolve(ref);
    if (!project.repoPath.trim()) throw new BoardError("invalid", "该项目还没有设置仓库路径");
    return project;
  }

  return {
    get(ref: string) {
      const project = repoOf(ref);
      try {
        return readRequirementsDoc(project.repoPath, project.requirementsPath);
      } catch (error) {
        throw toRequirementsError(error);
      }
    },
    async save(ref: string, content: string) {
      const project = repoOf(ref);
      try {
        return await writeRequirementsDoc(
          project.repoPath,
          project.requirementsPath,
          content,
          REQUIREMENTS_COMMIT_MESSAGE,
          git,
        );
      } catch (error) {
        throw toRequirementsError(error);
      }
    },
    /** Publishes card.review_requested for a draft card; the master plugin consumes it. */
    requestReview(ref: string) {
      const card = board.cards.get(ref);
      if (card.column !== "draft") throw new BoardError("invalid", "只有草稿箱里的卡片可以让总 agent 审查");
      publishEvent(db, {
        type: "card.review_requested",
        cardId: card.id,
        projectId: card.projectId,
        payload: { cardId: card.id, requestedBy: "user" },
      });
      return { requested: true as const };
    },
  };
}

export type RequirementsService = ReturnType<typeof createRequirementsService>;
