import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayedFieldValue } from "../client/common/field";
import {
  emptyProjectDraft,
  parseDevices,
  projectDraftToPayload,
  projectToDraft,
  requirementsSaveMessage,
  thinkingAfterModelChange,
  thinkingChoices,
  toggleProjectType,
  toggleRoleHint,
  validateProjectDraft,
} from "../client/presets/logic";
import { createRequirementsService, toRequirementsError } from "../server/requirements";
import { registerBoardRpcs } from "../server/rpc";
import { RequirementsDocError } from "../server/vibe/db";
import { projectsCreateRpc, projectsUpdateRpc, requirementsGetRpc, requirementsSaveRpc } from "../shared/rpc";
import { setupBoard, tempDir } from "./helpers";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoWithProject() {
  const repo = tempDir("vibe-req-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const ctx = setupBoard();
  const { project } = ctx.board.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: repo,
    projectType: "web",
  });
  const service = createRequirementsService({ board: ctx.board, db: ctx.runtime.db });
  return { ...ctx, repo, project, service };
}

describe("TextField value reconciliation", () => {
  it("keeps the local text while focused and follows the parent otherwise", () => {
    expect(displayedFieldValue(true, "abc", "ab")).toBe("abc");
    expect(displayedFieldValue(false, "abc", "ab")).toBe("ab");
  });
});

describe("project form logic", () => {
  const project = {
    name: "Demo",
    prefix: "DEMO",
    repoPath: "/r",
    projectTypes: ["web", "backend"],
    projectType: "web",
    description: "desc",
    requirementsPath: "docs/REQ.md",
    defaultPresetId: null,
    concurrencyLimit: 2,
    devices: ["a", "b"],
    color: null,
  } as never;

  it("round-trips a project through the draft and the RPC schemas", () => {
    const draft = projectToDraft(project, "#111111");
    expect(draft).toMatchObject({ concurrencyLimit: "2", devices: "a, b", color: "#111111" });
    expect(validateProjectDraft(draft, "edit")).toBeNull();
    const payload = projectDraftToPayload(draft);
    expect(payload.projectTypes).toEqual(["web", "backend"]);
    expect(projectsUpdateRpc.input.safeParse({ project: "DEMO", ...payload }).success).toBe(true);
    expect(projectsCreateRpc.input.safeParse({ ...payload, prefix: "DEMO" }).success).toBe(true);
  });

  it("validates types, path and concurrency", () => {
    const base = { ...emptyProjectDraft("#000"), name: "N", prefix: "N", projectTypes: ["web" as const] };
    expect(validateProjectDraft(base, "create")).toBeNull();
    expect(validateProjectDraft({ ...base, projectTypes: [] }, "create")).toContain("类型");
    expect(validateProjectDraft({ ...base, prefix: "" }, "create")).toContain("前缀");
    expect(validateProjectDraft({ ...base, prefix: "" }, "edit")).toBeNull();
    expect(validateProjectDraft({ ...base, requirementsPath: "../x.md" }, "edit")).toContain("相对路径");
    expect(validateProjectDraft({ ...base, requirementsPath: "/abs.md" }, "edit")).toContain("相对路径");
    expect(validateProjectDraft({ ...base, concurrencyLimit: "0" }, "edit")).toContain("并发");
    expect(projectDraftToPayload({ ...base, concurrencyLimit: " " }).concurrencyLimit).toBeNull();
    expect(projectDraftToPayload({ ...base, concurrencyLimit: "3" }).concurrencyLimit).toBe(3);
  });

  it("toggles types in click order and parses devices", () => {
    expect(toggleProjectType(["web"], "android")).toEqual(["web", "android"]);
    expect(toggleProjectType(["web", "android"], "web")).toEqual(["android"]);
    expect(parseDevices("a, b，a\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("preset purposes and thinking", () => {
  const models = [
    {
      id: "m1",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    { id: "m2", thinkingOptions: [{ id: "high", label: "High" }] },
    { id: "m3" },
  ];

  it("toggles purposes in canonical order", () => {
    expect(toggleRoleHint([], "reviewer")).toEqual(["reviewer"]);
    expect(toggleRoleHint(["reviewer"], "worker")).toEqual(["worker", "reviewer"]);
    expect(toggleRoleHint(["worker", "reviewer"], "worker")).toEqual(["reviewer"]);
  });

  it("offers default + model levels and keeps an unlisted saved value", () => {
    expect(thinkingChoices(models, "m1", "").map((o) => o.id)).toEqual(["", "low", "high"]);
    expect(thinkingChoices(models, "m3", "").map((o) => o.id)).toEqual([""]);
    const kept = thinkingChoices(models, "m2", "xhigh");
    expect(kept.map((o) => o.id)).toEqual(["", "high", "xhigh"]);
    expect(kept[2]!.label).toBe("很高（当前值）");
  });

  it("labels levels the same way for codex ('low') and claude ('Low')", () => {
    const mixed = [
      { id: "codex-m", thinkingOptions: [{ id: "low", label: "low" }, { id: "xhigh", label: "xhigh" }] },
      { id: "claude-m", thinkingOptions: [{ id: "low", label: "Low" }, { id: "max", label: "Max" }] },
    ];
    expect(thinkingChoices(mixed, "codex-m", "").map((o) => o.label)).toEqual(["默认", "低", "很高"]);
    expect(thinkingChoices(mixed, "claude-m", "").map((o) => o.label)).toEqual(["默认", "低", "最高"]);
  });

  it("resets thinking to default only when the new model lacks it", () => {
    expect(thinkingAfterModelChange(models, "m2", "high")).toBe("high");
    expect(thinkingAfterModelChange(models, "m2", "low")).toBe("");
    expect(thinkingAfterModelChange(models, "unknown", "low")).toBe("");
    expect(thinkingAfterModelChange(models, "m1", "")).toBe("");
  });
});

describe("requirements RPCs on a real git repo", () => {
  it("reads a missing doc, creates + commits it, and skips an identical save", async () => {
    const { service, repo, project } = repoWithProject();
    expect(service.get(project.id)).toEqual({ path: "PRODUCT-REQUIREMENTS.md", exists: false, content: "" });
    const saved = await service.save(project.id, "# Req\r\n- one\r\n");
    expect(saved).toMatchObject({ committed: true, created: true, exists: true, content: "# Req\n- one\n" });
    expect(saved.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("docs: update product requirements (myVibeBoard)");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("PRODUCT-REQUIREMENTS.md");
    expect(requirementsSaveMessage(saved)).toContain(saved.commit!.slice(0, 8));
    const again = await service.save(project.id, "# Req\n- one\n");
    expect(again).toMatchObject({ committed: false, commit: null, created: false });
    expect(requirementsSaveMessage(again)).toContain("未产生提交");
    expect(service.get(project.id).content).toBe("# Req\n- one\n");
  });

  it("commits only the requirements file and honours a custom path", async () => {
    const { service, repo, project, board } = repoWithProject();
    board.projects.update(project.id, { requirementsPath: "docs/REQ.md" });
    writeFileSync(join(repo, "README.md"), "dirty\n");
    mkdirSync(join(repo, "docs"), { recursive: true });
    const saved = await service.save(project.id, "x\n");
    expect(saved.path).toBe("docs/REQ.md");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("docs/REQ.md");
    expect(git(repo, "status", "--porcelain")).toBe("M README.md");
  });

  it("maps repo-busy and ignored errors to Chinese board errors", async () => {
    const { service, repo, project } = repoWithProject();
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${git(repo, "rev-parse", "HEAD")}\n`);
    await expect(service.save(project.id, "x")).rejects.toThrow(/\[conflict\].*合并/);
    unlinkSync(join(repo, ".git", "MERGE_HEAD"));
    writeFileSync(join(repo, ".gitignore"), "PRODUCT-REQUIREMENTS.md\n");
    await expect(service.save(project.id, "x")).rejects.toThrow(/\[invalid\].*gitignore/);
    expect(toRequirementsError(new RequirementsDocError("invalid_path", "x")).message).toContain("相对路径");
  });

  it("rejects a project without a repository path", () => {
    const { board, runtime } = setupBoard();
    const { project } = board.projects.create({ name: "NoRepo", prefix: "NR", repoPath: "", projectType: "web" });
    const service = createRequirementsService({ board, db: runtime.db });
    expect(() => service.get(project.id)).toThrow(/仓库路径/);
  });

  it("is served through registerBoardRpcs with schema-valid output", async () => {
    const { board, runtime, project, repo } = repoWithProject();
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    registerBoardRpcs({ handle: (def: { name: string }, fn: never) => handlers.set(def.name, fn) } as never, board, {
      requirements: createRequirementsService({ board, db: runtime.db }),
    });
    const got = requirementsGetRpc.output.parse(await handlers.get(requirementsGetRpc.name)!({ project: "DEMO" }, {}));
    expect(got.exists).toBe(false);
    const saved = requirementsSaveRpc.output.parse(
      await handlers.get(requirementsSaveRpc.name)!({ project: project.id, content: "a\n" }, {}),
    );
    expect(saved.committed).toBe(true);
    expect(existsSync(join(repo, "PRODUCT-REQUIREMENTS.md"))).toBe(true);
    expect(readFileSync(join(repo, "PRODUCT-REQUIREMENTS.md"), "utf8")).toBe("a\n");
  });
});

describe("manual review request", () => {
  it("publishes card.review_requested for a draft card only", () => {
    const { service, board, runtime, project } = repoWithProject();
    const { card } = board.cards.create({ project: project.id, title: "Idea" });
    expect(service.requestReview(card.key)).toEqual({ requested: true });
    const rows = runtime.db
      .prepare<{ type: string; card_id: string; payload_json: string }>(
        "SELECT type, card_id, payload_json FROM vibe_event WHERE type = 'card.review_requested'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card_id).toBe(card.id);
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ cardId: card.id, requestedBy: "user" });
    board.cards.move(card.key, { to: "todo" });
    expect(() => service.requestReview(card.key)).toThrow(/草稿箱/);
  });
});
