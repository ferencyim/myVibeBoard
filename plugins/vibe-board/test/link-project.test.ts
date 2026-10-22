import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { linkPaseoProject, type LinkPaseo } from "../server/dispatch/link-project";
import { setupBoard } from "./helpers";

function fakePaseo(initial: Array<{ projectId: string; projectRootPath: string; projectDisplayName?: string }>) {
  const projects = initial.map((p) => ({ projectDisplayName: "x", projectKind: "git", ...p }));
  const open = vi.fn(async (path: string) => {
    projects.push({ projectId: `new-${projects.length}`, projectRootPath: path, projectDisplayName: "new", projectKind: "git" });
    return { projectId: projects.at(-1)!.projectId };
  });
  const paseo = { projects: { list: async () => ({ projects }) }, workspaces: { open } } as unknown as LinkPaseo;
  return { paseo, open };
}

function setup(repoPath: string, paseoProjectId?: string) {
  const { board } = setupBoard();
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath, paseoProjectId });
  return { board, project };
}

describe("linkPaseoProject", () => {
  it("links an existing Paseo project by repository path (case and slash insensitive)", async () => {
    const { board, project } = setup("d:/repo/demo/");
    const { paseo, open } = fakePaseo([{ projectId: "pp1", projectRootPath: "D:\\Repo\\Demo" }]);
    const result = await linkPaseoProject(board, paseo, project, { isDirectory: () => false });
    expect(result.paseoProject.projectId).toBe("pp1");
    expect(board.projects.resolve("DEMO").paseoProjectId).toBe("pp1");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the repository in Paseo when no project matches, then links the new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-link-"));
    const { board, project } = setup(dir);
    const { paseo, open } = fakePaseo([{ projectId: "other", projectRootPath: "/somewhere/else" }]);
    const result = await linkPaseoProject(board, paseo, project);
    expect(open).toHaveBeenCalledWith(dir);
    expect(result.paseoProject.projectRootPath).toBe(dir);
    expect(board.projects.resolve("DEMO").paseoProjectId).toBe(result.paseoProject.projectId);
  });

  it("replaces a stale link by the path lookup", async () => {
    const { board, project } = setup("/repo/demo", "gone");
    const { paseo } = fakePaseo([{ projectId: "pp9", projectRootPath: "/repo/demo" }]);
    await linkPaseoProject(board, paseo, project, { isDirectory: () => true });
    expect(board.projects.resolve("DEMO").paseoProjectId).toBe("pp9");
  });

  it("explains a blank or missing repository path", async () => {
    const blank = setup("  ");
    const { paseo, open } = fakePaseo([]);
    await expect(linkPaseoProject(blank.board, paseo, blank.project)).rejects.toThrow(/没有设置仓库路径.*管理/);
    const missing = setup("/definitely/not/here");
    await expect(
      linkPaseoProject(missing.board, paseo, missing.project, { isDirectory: () => false }),
    ).rejects.toThrow(/仓库路径不存在或不是目录：\/definitely\/not\/here.*管理/);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("board tag editing", () => {
  it("renames and recolors a tag through the service; cards follow the same id", () => {
    const { board } = setupBoard();
    const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "/r" });
    const { tag } = board.tags.create("spike", false, "#8b5cf6");
    const { card } = board.cards.create({ project: project.prefix, title: "t", tagIds: [tag.id] });
    const updated = board.tags.update(tag.id, { name: "experiment", color: "#14b8a6" }).tag;
    expect(updated).toMatchObject({ id: tag.id, name: "experiment", color: "#14b8a6" });
    expect(board.cards.detail(card.key).card.tags).toEqual([tag.id]);
    expect(() => board.tags.update(tag.id, { name: "bug" })).toThrow(/已存在|already exists/);
  });
});
