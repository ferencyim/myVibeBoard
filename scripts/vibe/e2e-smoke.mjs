// WP-114 live smoke: native task conversation -> plan/review -> execute -> verify -> accept.
// Run only against scripts/vibe/dev-daemon.ps1 with all current vibe plugins installed.
// Required: VIBE_E2E_HOME=D:/devRepoCaches/r5-114-home, VIBE_E2E_MODEL=<cheap Codex model>.
// Optional: VIBE_E2E_PORT=17114, VIBE_E2E_CLIENT=<built daemon-client.js>, SMOKE_STEP_TIMEOUT_MIN=12.
// The daemon must use isolated CODEX_HOME and worktrees.root=<this checkout>/.dev/wp114-worktrees.
// Creates unique test repositories and keeps every artifact; never deletes or touches the product Git tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const home = path.resolve(process.env.VIBE_E2E_HOME || "");
const allowedHome = path.resolve("D:/devRepoCaches/r5-114-home");
assert.equal(
  home.toLowerCase(),
  allowedHome.toLowerCase(),
  "VIBE_E2E_HOME must explicitly name the WP-114 isolated home",
);
const model = process.env.VIBE_E2E_MODEL;
assert.ok(
  model,
  "Set VIBE_E2E_MODEL to an available cheap Codex model; no automatic costly fallback",
);
const port = Number(process.env.VIBE_E2E_PORT || 17114);
assert.ok(port === 17114 || (port >= 17140 && port <= 17199), "Use the WP-114 isolated port range");
const config = JSON.parse(
  readFileSync(path.join(home, "paseo/config.json"), "utf8").replace(/^\uFEFF/, ""),
);
assert.equal(config.daemon?.relay?.enabled, false, "Isolated daemon relay must be disabled");
const worktreesRoot = path.resolve(config.worktrees?.root || "");
const expectedRoot = path.join(checkout, ".dev/wp114-worktrees");
assert.equal(
  worktreesRoot.toLowerCase(),
  expectedRoot.toLowerCase(),
  "Set isolated worktrees.root to this checkout/.dev/wp114-worktrees",
);
execFileSync("git", ["check-ignore", expectedRoot], { cwd: checkout, stdio: "pipe" });
const runId = `wp114-${Date.now()}-${process.pid}`;
const runDir = path.join(home, runId);
const repo = path.join(runDir, "main");
const origin = path.join(runDir, "origin.git");
mkdirSync(repo, { recursive: true });
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true });
git(runDir, "init", "--bare", "--initial-branch=main", origin);
git(repo, "init", "--initial-branch=main");
git(repo, "config", "user.email", "smoke@example.invalid");
git(repo, "config", "user.name", "隔离烟测");
git(repo, "config", "core.autocrlf", "false");
writeFileSync(path.join(repo, "README.md"), "# 隔离新流程烟测\n");
writeFileSync(
  path.join(repo, "package.json"),
  JSON.stringify({ private: true, scripts: { test: "node check.cjs" } }, null, 2) + "\n",
);
writeFileSync(
  path.join(repo, "check.cjs"),
  'const assert = require("node:assert/strict");\nassert.equal(require("node:fs").readFileSync("hello.txt", "utf8"), "hello vibe\\n");\nconsole.log("hello.txt ok");\n',
);
git(repo, "add", "README.md", "package.json", "check.cjs");
git(repo, "commit", "-m", "初始化隔离烟测仓库");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-u", "origin", "main");
const { DaemonClient } = await import(
  pathToFileURL(
    process.env.VIBE_E2E_CLIENT || path.join(checkout, "packages/client/dist/daemon-client.js"),
  ).href
);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: runId,
  appVersion: "0.12.0",
  localCredential: () => readFileSync(path.join(home, "paseo/local-credential"), "utf8").trim(),
  reconnect: { enabled: false },
});
const evidence = { runId, repo, origin, model, steps: [] };
const save = () =>
  writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
const record = (name, detail) => {
  evidence.steps.push({ name, at: new Date().toISOString(), detail });
  save();
  console.log(name, typeof detail === "string" ? detail : "");
};
const board = (name, input) => client.invokePluginRpc("vibe-board", name, input);
const timeout = Number(process.env.SMOKE_STEP_TIMEOUT_MIN || 12) * 60_000;
let workspaceId, conversationId;
const panel = () => board("vibe.task.conversation.panel", { workspaceId, conversationId });
const command = (action, extra = {}) =>
  board("vibe.task.conversation.command", {
    workspaceId,
    conversationId,
    action,
    requestId: `${runId}:${action}:${Date.now()}`,
    ...extra,
  });
async function waitFor(label, predicate) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const current = await panel();
    evidence.lastPanel = current;
    save();
    if (await predicate(current)) {
      record(label, current.task?.phase);
      return current;
    }
    if (["paused", "failed"].includes(current.task?.phase))
      throw new Error(`${label}: ${current.task.phase}: ${current.task.summary}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out: ${label}; inspect ${runDir}/evidence.json`);
}
try {
  await client.connect();
  const plugins = await client.listPlugins();
  assert.ok(
    plugins.some((plugin) => plugin.id === "vibe-board" && plugin.status === "running"),
    "The task owner plugin must be running before the first message",
  );
  const { preset } = await board("vibe.presets.create", {
    name: runId,
    provider: "codex",
    model,
    thinking: process.env.VIBE_E2E_THINKING || "low",
    permissionMode: "full",
    environmentKind: "new-worktree",
    instructions:
      "所有输出用中文。仅在本次隔离测试仓库内工作。提交信息用中文。不自行合并或推送。" +
      (process.env.VIBE_E2E_INSTRUCTIONS || ""),
  });
  await board("vibe.defaults.set", {
    global: {
      planner: preset.id,
      worker: preset.id,
      subagent: preset.id,
      reviewer: preset.id,
      verifier: preset.id,
    },
  });
  const created = await client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repo,
      action: "branch-off",
      baseBranch: "main",
      branchName: runId,
      worktreeSlug: runId,
    },
    title: "WP-114 隔离完整流程",
    taskConversation: {
      ownerPluginId: "vibe-board",
      idempotencyKey: runId,
      initialRecipient: {
        role: "planner",
        presetId: preset.id,
        config: {
          provider: "codex",
          cwd: repo,
          model,
          thinkingOptionId: process.env.VIBE_E2E_THINKING || "low",
          modeId: "auto",
          providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
        },
      },
      initialMessage: {
        clientMessageId: `${runId}:first`,
        text: "请为本隔离仓库制定最小完整方案：在根目录新增 hello.txt，内容严格为 hello vibe 加一个换行，运行 node check.cjs 验证，git add hello.txt 后用中文信息提交。必须规划一个子任务，由主代理使用 vibe-delegate 委派该子任务完成文件修改与提交；主代理复查。仅改 hello.txt，不合并、不推送，等待用户通过。验收标准为内容正确、check.cjs 成功、改动已提交、工作树干净。先制定方案，禁止执行。",
      },
    },
  });
  if (created.error) throw new Error(created.error);
  workspaceId = created.workspace?.id;
  assert.ok(workspaceId, "workspace created");
  assert.ok(created.workspace.projectId, "native project exists");
  // Verification uses explicit project settings, just like a user configuring
  // 任务设置 → 管理项目与 Agent 预设. The product must not guess this association.
  const { project } = await board("vibe.projects.create", {
    name: runId,
    prefix: `W${Date.now().toString(36).toUpperCase()}`,
    repoPath: repo,
    paseoProjectId: created.workspace.projectId,
    projectType: "backend",
    description: "隔离烟测：唯一测试命令 npm test，实际运行 node check.cjs。",
    defaultPresets: {
      planner: preset.id,
      worker: preset.id,
      subagent: preset.id,
      reviewer: preset.id,
      verifier: preset.id,
    },
  });
  record("关联原生项目的任务扩展配置", {
    projectId: project.id,
    paseoProjectId: created.workspace.projectId,
  });
  const resolved = await client.resolveTaskConversation({ workspaceId });
  assert.ok(resolved.conversation, resolved.error || "conversation created");
  conversationId = resolved.conversation.conversationId;
  evidence.workspaceId = workspaceId;
  evidence.conversationId = conversationId;
  record("首消息创建原生任务会话", { workspaceId, conversationId });
  await waitFor(
    "初始方案完成",
    (p) => p.task?.phase === "awaiting_confirmation" && !!p.latestPlanSource,
  );
  for (const role of ["scout", "plan_reviewer", "worker", "subagent", "reviewer", "verifier"])
    await board("vibe.task.conversation.select_role", {
      workspaceId,
      conversationId,
      role,
      selection: { mode: "preset", presetId: preset.id },
    });
  await command("plan", { reason: "先只读探路，再保留同一个最小子任务并更新方案。" });
  const scouted = await waitFor(
    "探路及规划接续完成",
    (p) =>
      p.task?.phase === "awaiting_confirmation" &&
      !!p.latestPlanSource &&
      p.artifacts.some((a) => a.kind === "scout") &&
      !p.members.some((m) => ["running", "initializing"].includes(m.status)),
  );
  await command("review_plan", { source: scouted.latestPlanSource });
  const planned = await waitFor(
    "方案复核交回规划完成",
    (p) =>
      p.task?.phase === "awaiting_confirmation" &&
      !!p.latestPlanSource &&
      p.artifacts.some((a) => a.kind === "plan_review") &&
      !p.members.some((m) => ["running", "initializing"].includes(m.status)),
  );
  assert.ok(planned.latestPlanSource, "latest complete plan has source");
  await command("execute", { source: planned.latestPlanSource });
  record("显式执行已确认最新方案", "执行授权由任务命令发出");
  const verified = await waitFor(
    "执行、代码复核与必需验证完成",
    (p) => p.task?.phase === "awaiting_acceptance",
  );
  assert.ok(
    verified.artifacts.some((a) => a.kind === "review"),
    "review artifact exists",
  );
  assert.ok(
    verified.artifacts.some((a) => a.kind === "verification"),
    "verification artifact exists",
  );
  await command("accept");
  const done = await waitFor("通过后完成安全合并与 push", (p) => p.task?.phase === "completed");
  assert.equal(readFileSync(path.join(repo, "hello.txt"), "utf8"), "hello vibe\n");
  const mainCommit = git(repo, "rev-parse", "main").trim();
  assert.equal(git(origin, "rev-parse", "refs/heads/main").trim(), mainCommit);
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  assert.ok(git(repo, "worktree", "list").includes(runId), "completed worktree is retained");
  record("本地 main 与裸 origin 一致、主检出干净、worktree 保留", {
    mainCommit,
    artifacts: done.artifacts.map((a) => a.kind),
  });
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error?.stack || error);
  record("失败", evidence.error);
  process.exitCode = 1;
} finally {
  save();
  await client.close?.();
  console.log(`Evidence: ${path.join(runDir, "evidence.json")}`);
}
