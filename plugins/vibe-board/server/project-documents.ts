import { setInterval, clearInterval } from "node:timers";
import { createHash } from "node:crypto";
import { lstat, readdir, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { migrateOwner, type VibeDb } from "./vibe/db";
import {
  projectDocumentsGetRpc,
  projectBriefSubmitRpc,
  briefEditSchema,
  briefPathSchema,
  type BriefEdit,
  type ProjectDocumentSnapshot,
} from "../shared/project-documents";
const LIMIT = 64 * 1024;
interface NativeProject {
  projectId: string;
  projectRootPath: string;
}
interface Row {
  path: string;
  content: string;
  total_bytes: number;
  truncated: number;
  revision: string;
  synced_at: string;
}
interface ChangeRow {
  id: string;
  documents_json: string;
  created_at: string;
  delivered_at: string | null;
}
export function createProjectDocuments(options: {
  db: VibeDb;
  listProjects(): Promise<readonly NativeProject[]>;
  notifyMerge(projectId: string, text: string): Promise<unknown>;
  now?: () => Date;
}) {
  const { db } = options;
  migrateOwner(db, "context");
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const active = new Map<string, Promise<void>>();
  const delivering = new Set<string>();
  async function projectRoot(projectId: string) {
    const project = (await options.listProjects()).find((p) => p.projectId === projectId);
    if (!project) throw new Error("项目不存在");
    return realpath(project.projectRootPath);
  }
  async function scan(projectId: string, project?: NativeProject) {
    const root = project ? await realpath(project.projectRootPath) : await projectRoot(projectId);
    const paths = ["AGENTS.md", "CLAUDE.md", "PRODUCT-REQUIREMENTS.md"];
    async function walk(dir: string) {
      try {
        if ((await lstat(join(root, dir))).isSymbolicLink()) return;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      let entries;
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = dir + "/" + entry.name;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) paths.push(file);
      }
    }
    await walk("docs");
    const records: Row[] = [];
    for (const file of paths.sort()) {
      const full = join(root, file);
      try {
        if ((await lstat(full)).isSymbolicLink()) continue;
        const actual = await realpath(full);
        const rel = relative(root, actual);
        if (rel.startsWith(".." + sep) || rel === "..") continue;
        const handle = await open(actual, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) continue;
          const buffer = Buffer.alloc(Math.min(stat.size, LIMIT));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const content = new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead));
          const revision = createHash("sha256")
            .update(content)
            .update(String(stat.size))
            .update(String(stat.mtimeMs))
            .digest("hex");
          records.push({
            path: file,
            content,
            total_bytes: stat.size,
            truncated: Number(stat.size > LIMIT),
            revision,
            synced_at: now(),
          });
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    db.immediate(() => {
      const retained = new Set(records.map((r) => r.path));
      for (const row of db
        .prepare<{ path: string }>("SELECT path FROM project_document WHERE project_id=?")
        .all(projectId))
        if (!retained.has(row.path))
          db.prepare("DELETE FROM project_document WHERE project_id=? AND path=?").run(
            projectId,
            row.path,
          );
      for (const r of records)
        db.prepare(
          `INSERT INTO project_document(project_id,path,content,total_bytes,truncated,revision,synced_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content,total_bytes=excluded.total_bytes,truncated=excluded.truncated,revision=excluded.revision,synced_at=CASE WHEN project_document.revision=excluded.revision THEN project_document.synced_at ELSE excluded.synced_at END`,
        ).run(projectId, r.path, r.content, r.total_bytes, r.truncated, r.revision, r.synced_at);
    });
  }
  async function sync(projectId: string, project?: NativeProject) {
    const previous = active.get(projectId);
    if (previous) return previous;
    const work = scan(projectId, project);
    active.set(projectId, work);
    try {
      await work;
    } finally {
      active.delete(projectId);
    }
  }
  function snapshot(projectId: string): ProjectDocumentSnapshot {
    return {
      documents: db
        .prepare<Row>("SELECT * FROM project_document WHERE project_id=? ORDER BY path")
        .all(projectId)
        .map((r) => ({
          path: r.path,
          content: r.content,
          totalBytes: r.total_bytes,
          truncated: !!r.truncated,
          revision: r.revision,
          syncedAt: r.synced_at,
        })),
      pending: db
        .prepare<ChangeRow>(
          "SELECT * FROM project_brief_change WHERE project_id=? AND merged_at IS NULL ORDER BY created_at",
        )
        .all(projectId)
        .map((r) => ({
          id: r.id,
          documents: z.array(briefEditSchema).parse(JSON.parse(r.documents_json)),
          createdAt: r.created_at,
          deliveredAt: r.delivered_at,
        })),
    };
  }
  async function deliver(projectId: string) {
    for (const change of snapshot(projectId).pending) {
      if (change.deliveredAt || delivering.has(change.id)) continue;
      delivering.add(change.id);
      try {
        await options.notifyMerge(
          projectId,
          "[项目简介待合并修改；来源：用户在项目设置中编辑，可能离线保存]\n修改 ID：" +
            change.id +
            "\n请将以下用户建议与仓库当前文件合并，不得直接覆盖；检查不包含密钥、主机地址和用户名。保存后调用 vibe_project_brief 的 complete 操作清除待合并标记。\n" +
            JSON.stringify(change.documents),
        );
        db.prepare("UPDATE project_brief_change SET delivered_at=? WHERE id=?").run(
          now(),
          change.id,
        );
      } finally {
        delivering.delete(change.id);
      }
    }
  }
  async function submit(projectId: string, id: string, documents: BriefEdit[]) {
    await projectRoot(projectId);
    if (new Set(documents.map((d) => d.path)).size !== documents.length)
      throw new Error("简介文件不能重复");
    const existing = db
      .prepare<{ project_id: string; documents_json: string }>(
        "SELECT project_id,documents_json FROM project_brief_change WHERE id=?",
      )
      .get(id);
    const json = JSON.stringify(documents);
    if (existing && (existing.project_id !== projectId || existing.documents_json !== json))
      throw new Error("修改 ID 已用于其它内容");
    if (!existing)
      db.prepare(
        "INSERT INTO project_brief_change(id,project_id,documents_json,created_at) VALUES(?,?,?,?)",
      ).run(id, projectId, json, now());
    // Durable queue is authoritative even when starting the agent fails. Periodic reconciliation retries.
    try {
      await deliver(projectId);
    } catch {
      /* preserved for retry */
    }
    return snapshot(projectId);
  }
  async function complete(
    projectId: string,
    id: string,
    expectedRevisions?: { path: string; revision: string }[],
  ) {
    await sync(projectId);
    const change = snapshot(projectId).pending.find((c) => c.id === id);
    if (!change) throw new Error("待合并修改不存在");
    const docs = snapshot(projectId).documents;
    if (
      !change.documents.every((d) =>
        docs.some(
          (current) =>
            current.path === d.path &&
            (current.revision !== d.baseRevision || current.content === d.content),
        ),
      )
    )
      throw new Error("文件尚未更新，不能清除待合并标记");
    if (
      expectedRevisions &&
      !change.documents.every((d) =>
        expectedRevisions.some(
          (e) =>
            e.path === d.path &&
            docs.some((current) => current.path === e.path && current.revision === e.revision),
        ),
      )
    )
      throw new Error("文件在合并确认前再次变化，请重读后确认");
    db.prepare("UPDATE project_brief_change SET merged_at=? WHERE project_id=? AND id=?").run(
      now(),
      projectId,
      id,
    );
    return snapshot(projectId);
  }
  async function writeBrief(
    projectId: string,
    file: "AGENTS.md" | "CLAUDE.md",
    content: string,
    expectedRevision: string,
  ) {
    await sync(projectId);
    const root = await projectRoot(projectId);
    const current = snapshot(projectId).documents.find((d) => d.path === file);
    if ((current?.revision ?? "") !== expectedRevision)
      throw new Error("项目简介已变化，请重读后合并");
    if (current?.truncated) throw new Error("简介超过缓存上限，请用文件工具合并完整文件");
    const target = join(root, file);
    const handle = await open(target, current ? "r+" : "wx");
    try {
      if ((await lstat(target)).isSymbolicLink() || (await realpath(target)) !== target)
        throw new Error("简介不能是符号链接");
      const stat = await handle.stat();
      const before = await handle.readFile("utf8");
      const revision = createHash("sha256")
        .update(before)
        .update(String(stat.size))
        .update(String(stat.mtimeMs))
        .digest("hex");
      if (current && revision !== expectedRevision) throw new Error("项目简介已变化，请重读后合并");
      await handle.write(Buffer.from(content), 0, Buffer.byteLength(content), 0);
      await handle.truncate(Buffer.byteLength(content));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await sync(projectId);
    return snapshot(projectId);
  }
  let stopped = false;
  const lastErrors = new Map<string, number>();
  function report(key: string) {
    const time = Date.now();
    if (time - (lastErrors.get(key) ?? 0) < 60000) return;
    lastErrors.set(key, time);
    console.warn("[vibe-board] 项目文档同步暂未完成，将重试", key);
  }
  let reconciling: Promise<void> | null = null;
  async function reconcile() {
    for (const project of await options.listProjects()) {
      if (stopped) return;
      try {
        await sync(project.projectId, project);
        await deliver(project.projectId);
      } catch (error) {
        report(errorCode(error) ?? "document_sync_failed");
      }
    }
  }
  const refresh = () => {
    if (reconciling) return reconciling;
    reconciling = reconcile()
      .catch((error) => report(errorCode(error) ?? "project_list_failed"))
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  };
  const timer = setInterval(() => {
    void refresh();
  }, 15000);
  return {
    sync,
    snapshot,
    submit,
    complete,
    writeBrief,
    start: () => refresh(),
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await reconciling;
      await Promise.allSettled(active.values());
    },
  };
}
export type ProjectDocuments = ReturnType<typeof createProjectDocuments>;
export function registerProjectDocumentRpcs(
  server: PluginServerContext,
  documents: ProjectDocuments,
  callerProject: (agentId: string) => Promise<string> | string,
) {
  server.handle(projectDocumentsGetRpc, async ({ projectId }) => {
    await documents.sync(projectId);
    return documents.snapshot(projectId);
  });
  server.handle(projectBriefSubmitRpc, ({ projectId, id, documents: edits }, { callerAgentId }) => {
    if (callerAgentId) throw new Error("简介修改只接受用户在项目设置里的输入");
    return documents.submit(projectId, id, edits);
  });
  const input = z
    .object({
      action: z.enum(["read", "write", "complete"]),
      path: briefPathSchema.optional(),
      content: z.string().max(262144).optional(),
      expectedRevision: z.string().optional(),
      changeId: z.string().optional(),
      expectedRevisions: z.array(z.object({ path: z.string(), revision: z.string() })).optional(),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_project_brief",
    description:
      "读取本项目 AGENTS.md / CLAUDE.md 简介快照、文档列表及待合并修改；write 用 expectedRevision 合并写入简介，禁止密钥、主机地址、用户名；合并写回真实文件后用 complete(changeId) 清除标记。仅项目 agent 可用。",
    input,
    handler: async (value, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("仅项目 agent 可调用");
      const projectId = await callerProject(callerAgentId);
      const args = input.parse(value);
      if (args.action === "write") {
        if (!args.path || args.content === undefined || args.expectedRevision === undefined)
          throw new Error("写入需 path/content/expectedRevision");
        return documents.writeBrief(projectId, args.path, args.content, args.expectedRevision);
      }
      if (args.action === "complete") {
        if (!args.changeId) throw new Error("缺少修改 ID");
        if (!args.expectedRevisions)
          throw new Error("请先读取快照，传入合并后的文件 revision 以确认");
        return documents.complete(projectId, args.changeId, args.expectedRevisions);
      }
      await documents.sync(projectId);
      return documents.snapshot(projectId);
    },
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
