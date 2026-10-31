import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVibeDb, migrateOwner } from "../server/vibe/db";
import { createProjectDocuments, registerProjectDocumentRpcs } from "../server/project-documents";
import type { PluginServerContext, PluginAgentTool } from "@getpaseo/plugin/server";
const timer = vi.hoisted(() => ({ tick: undefined as (() => void) | undefined }));
vi.mock("node:timers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers")>()),
  setInterval: (callback: () => void) => { timer.tick = callback; return 1; },
  clearInterval: () => { timer.tick = undefined; },
}));
describe("project document snapshots", () => {
  it("retries delivery every tick, scans every fourth tick, and scans when start overlaps delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-docs-"));
    const db = openVibeDb({ path: ":memory:" });
    const prepare = vi.spyOn(db, "prepare");
    let release!: () => void;
    const notify = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = createProjectDocuments({
      db,
      listProjects: async () => [{ projectId: "project", projectRootPath: root }],
      notifyMerge: notify,
    });
    try {
      await writeFile(join(root, "AGENTS.md"), "initial");
      await service.start();
      await writeFile(join(root, "AGENTS.md"), "changed");
      db.prepare("INSERT INTO project_brief_change(id,project_id,documents_json,created_at) VALUES(?,?,?,?)")
        .run("change", "project", "[]", new Date().toISOString());
      timer.tick!();
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      const start = service.start();
      release();
      await start;
      expect(service.snapshot("project").documents[0].content).toBe("changed");
      await writeFile(join(root, "AGENTS.md"), "third version");
      const deliveryReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("SELECT * FROM project_brief_change WHERE project_id=")).length;
      for (let i = 0; i < 2; i++) {
        const before = deliveryReads();
        timer.tick!();
        await vi.waitFor(() => expect(deliveryReads()).toBeGreaterThan(before));
      }
      expect(service.snapshot("project").documents[0].content).toBe("changed");
      timer.tick!();
      await vi.waitFor(() => expect(service.snapshot("project").documents[0].content).toBe("third version"));
    } finally {
      await service.close();
      db.close();
      await unlink(join(root, "AGENTS.md"));
      await rmdir(root);
    }
  });
  it("avoids reading document bodies for delivery and rewriting unchanged snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-docs-"));
    const db = openVibeDb({ path: ":memory:" });
    const prepare = vi.spyOn(db, "prepare");
    const service = createProjectDocuments({
      db,
      listProjects: async () => [{ projectId: "project", projectRootPath: root }],
      notifyMerge: async () => {},
    });
    try {
      await writeFile(join(root, "AGENTS.md"), "original");
      await service.start();
      expect(prepare.mock.calls.some(([sql]) => sql.includes("SELECT * FROM project_document"))).toBe(false);
      db.exec("CREATE TABLE document_updates (n INTEGER); CREATE TRIGGER count_document_updates AFTER UPDATE ON project_document BEGIN INSERT INTO document_updates VALUES (1); END");
      await service.start();
      expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM document_updates").get()?.n).toBe(0);
      await writeFile(join(root, "AGENTS.md"), "changed document");
      await service.start();
      expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM document_updates").get()?.n).toBe(1);
      expect(service.snapshot("project").documents[0].content).toBe("changed document");
    } finally {
      await service.close();
      db.close();
      await unlink(join(root, "AGENTS.md"));
      await rmdir(root);
    }
  });
  it("uses one host project list for an entire reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-docs-"));
    const db = openVibeDb({ path: ":memory:" });
    const listProjects = vi.fn(async () => [
      { projectId: "first", projectRootPath: root },
      { projectId: "second", projectRootPath: root },
    ]);
    const service = createProjectDocuments({ db, listProjects, notifyMerge: async () => {} });
    try {
      await service.start();
      expect(listProjects).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
      db.close();
      await rmdir(root);
    }
  });
  it("synchronizes bounded Markdown snapshots, persists merge intent, retries delivery and requires a file update", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-docs-"));
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "core");
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(undefined);
    const service = createProjectDocuments({
      db,
      listProjects: async () => [{ projectId: "project", projectRootPath: root }],
      notifyMerge: notify,
    });
    try {
      await writeFile(join(root, "AGENTS.md"), "original");
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs", "large.md"), "a".repeat(70000));
      await service.sync("project");
      const initial = service.snapshot("project");
      expect(initial.documents.map((d) => d.path)).toEqual(["AGENTS.md", "docs/large.md"]);
      expect(initial.documents[1]).toMatchObject({ truncated: true, totalBytes: 70000 });
      expect(initial.documents[1].content.length).toBe(65536);
      const edits = [
        {
          path: "AGENTS.md" as const,
          content: "suggestion",
          baseRevision: initial.documents[0].revision,
        },
      ];
      await service.submit("project", "change", edits);
      expect(service.snapshot("project").pending[0].deliveredAt).toBeNull();
      await service.submit("project", "change", edits);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(service.snapshot("project").pending).toHaveLength(1);
      await expect(
        service.submit("project", "change", [{ ...edits[0], content: "different" }]),
      ).rejects.toThrow("修改 ID");
      await expect(service.complete("project", "change")).rejects.toThrow("文件尚未更新");
      await writeFile(join(root, "AGENTS.md"), "merged suggestion");
      await service.complete("project", "change");
      expect(service.snapshot("project").pending).toEqual([]);
      const merged = service.snapshot("project").documents.find((d) => d.path === "AGENTS.md")!;
      await service.submit("project", "no-op", [
        { ...edits[0], content: merged.content, baseRevision: merged.revision },
      ]);
      await service.complete("project", "no-op", [
        { path: "AGENTS.md", revision: merged.revision },
      ]);
      await service.submit("project", "next", [{ ...edits[0], baseRevision: merged.revision }]);
      await service.writeBrief("project", "AGENTS.md", "next merged", merged.revision);
      await expect(
        service.complete("project", "next", [{ path: "AGENTS.md", revision: merged.revision }]),
      ).rejects.toThrow("再次变化");
      expect(service.snapshot("project").pending.map((c) => c.id)).toEqual(["next"]);
      await expect(
        service.writeBrief("project", "AGENTS.md", "bad overwrite", merged.revision),
      ).rejects.toThrow("简介已变化");
      await unlink(join(root, "docs", "large.md"));
      await service.sync("project");
      expect(service.snapshot("project").documents).toHaveLength(1);
    } finally {
      await service.close();
      db.close();
      await unlink(join(root, "AGENTS.md"));
      await rmdir(join(root, "docs"));
      await rmdir(root);
    }
  });
  it("rejects brief tool use outside the project role", async () => {
    const tools: PluginAgentTool[] = [];
    const db = openVibeDb({ path: ":memory:" });
    const documents = createProjectDocuments({
      db,
      listProjects: async () => [],
      notifyMerge: async () => {},
    });
    const sync = vi.spyOn(documents, "sync");
    registerProjectDocumentRpcs(
      {
        handle: vi.fn(),
        registerAgentTool: (tool: PluginAgentTool) => {
          tools.push(tool);
        },
      } as unknown as PluginServerContext,
      documents,
      () => {
        throw new Error("仅项目 agent");
      },
    );
    await expect(tools[0].handler({ action: "read" }, { callerAgentId: "task" })).rejects.toThrow(
      "仅项目 agent",
    );
    expect(sync).not.toHaveBeenCalled();
    await documents.close();
    db.close();
  });
});
