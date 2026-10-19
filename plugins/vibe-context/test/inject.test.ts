import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBlock,
  buildContextBlock,
  CONTEXT_START,
  injectContext,
  removeBlock,
  strategyFor,
} from "../server/inject";
import { createMemoryStore } from "../server/memory";

const MASTER = { role: "master" } as const;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A repo with committed `.vibe/` memory, the way a user repository carries it. */
function project(opts: { agentsMd?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "vibe-inj-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(repo);
  mkdirSync(join(home, "user"), { recursive: true });
  writeFileSync(join(home, "user", "user_directives.md"), "Always reply in Chinese.");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  const store = createMemoryStore({ projectRoot: repo, userHome: home, contextWindowTokens: 100_000 });
  store.writeProjectState(MASTER, "Phase: M5. The harbor module is half done.");
  store.recordDecision(MASTER, { body: "Use sqlite for the local store.", tag: "storage" });
  mkdirSync(store.layout.instructionsDir, { recursive: true });
  writeFileSync(join(store.layout.instructionsDir, "project_goals.md"), "Goal: ship the harbor app.");
  if (opts.agentsMd) writeFileSync(join(repo, "AGENTS.md"), "# Repo rules\nBe terse.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { base, repo, home, store };
}

function worktree(p: { base: string; repo: string }, name = "wt") {
  const dir = join(p.base, name);
  git(p.repo, "worktree", "add", "-q", "-b", name, dir);
  return dir;
}

const req = (provider: string, cwd: string, systemPrompt?: string) => ({
  config: { provider, cwd, ...(systemPrompt ? { systemPrompt } : {}) },
});

describe("context block", () => {
  it("orders user directives, project instructions, then memory", () => {
    const { store } = project();
    const block = buildContextBlock(store)!;
    const at = (s: string) => block.indexOf(s);
    expect(at("Always reply in Chinese.")).toBeGreaterThan(0);
    expect(at("Always reply in Chinese.")).toBeLessThan(at("Goal: ship the harbor app."));
    expect(at("Goal: ship the harbor app.")).toBeLessThan(at("harbor module is half done"));
    expect(at("harbor module is half done")).toBeLessThan(at("Use sqlite"));
    expect(block).toContain("read-only");
    expect(block.startsWith(CONTEXT_START)).toBe(true);
  });

  it("points at files that do not fit the memory budget", () => {
    const { store } = project();
    const block = buildContextBlock(store, { maxMemoryTokens: 5 })!;
    expect(block).not.toContain("harbor module is half done");
    expect(block).toContain("read `.vibe/PROJECT_STATE.md`");
  });

  it("is null without a .vibe directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-none-"));
    const store = createMemoryStore({ projectRoot: dir, contextWindowTokens: 1000 });
    expect(buildContextBlock(store)).toBeNull();
  });

  it("applyBlock is idempotent and removeBlock restores the original", () => {
    const once = applyBlock("# Rules\n", `${CONTEXT_START}\nx\n<!-- vibe:context:end -->`);
    const twice = applyBlock(once, `${CONTEXT_START}\ny\n<!-- vibe:context:end -->`);
    expect(twice.match(/vibe:context:start/g)).toHaveLength(1);
    expect(twice).toContain("y");
    expect(twice).not.toContain("\nx\n");
    expect(removeBlock(twice).trim()).toBe("# Rules");
  });
});

describe("injection per provider", () => {
  it("maps the four supported providers", () => {
    expect(strategyFor("claude")).toBe("system-prompt");
    expect(strategyFor("codex")).toBe("AGENTS.override.md");
    expect(strategyFor("kimi")).toBe("AGENTS.md");
    expect(strategyFor("deepseek-harness")).toBe("AGENTS.md");
    expect(strategyFor("opencode")).toBeNull();
  });

  it("claude: prepends to systemPrompt once and leaves the repo untouched", async () => {
    const p = project();
    const opts = { userHome: p.home };
    const patch = await injectContext(req("claude", p.repo, "BOARD INSTRUCTIONS"), opts);
    expect(patch!.systemPrompt.startsWith(CONTEXT_START)).toBe(true);
    expect(patch!.systemPrompt.endsWith("BOARD INSTRUCTIONS")).toBe(true);
    expect(patch!.systemPrompt).toContain("harbor module is half done");
    expect(await injectContext(req("claude", p.repo, patch!.systemPrompt), opts)).toBeNull();
    expect(git(p.repo, "status", "--porcelain")).toBe("");
  });

  it("codex: writes an excluded AGENTS.override.md that also carries AGENTS.md", async () => {
    const p = project({ agentsMd: true });
    const wt = worktree(p);
    const opts = { userHome: p.home };
    expect(await injectContext(req("codex", wt), opts)).toBeNull();
    await injectContext(req("codex", wt), opts);
    const text = readFileSync(join(wt, "AGENTS.override.md"), "utf8");
    expect(text).toContain("Be terse.");
    expect(text).toContain("harbor module is half done");
    expect(text.match(/vibe:context:start/g)).toHaveLength(1);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).not.toContain("vibe:context");
  });

  it("kimi/deepseek: tracked AGENTS.md in a linked worktree is skip-worktree'd", async () => {
    const p = project({ agentsMd: true });
    for (const provider of ["kimi", "deepseek-harness"]) {
      const wt = worktree(p, `wt-${provider}`);
      await injectContext(req(provider, wt), { userHome: p.home });
      expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toContain("harbor module is half done");
      expect(git(wt, "status", "--porcelain")).toBe("");
      expect(git(wt, "add", "-A")).toBe("");
      expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
    }
  });

  it("kimi: an untracked AGENTS.md is git-excluded", async () => {
    const p = project();
    const wt = worktree(p);
    await injectContext(req("kimi", wt), { userHome: p.home });
    expect(existsSync(join(wt, "AGENTS.md"))).toBe(true);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("kimi: never edits a tracked AGENTS.md in the main checkout", async () => {
    const p = project({ agentsMd: true });
    await injectContext(req("kimi", p.repo), { userHome: p.home });
    expect(readFileSync(join(p.repo, "AGENTS.md"), "utf8")).toBe("# Repo rules\nBe terse.\n");
  });

  it("does nothing for non-vibe directories and unknown providers", async () => {
    const p = project();
    const plain = mkdtempSync(join(tmpdir(), "vibe-plain-"));
    expect(await injectContext(req("claude", plain), { userHome: p.home })).toBeNull();
    expect(await injectContext(req("opencode", p.repo), { userHome: p.home })).toBeNull();
  });
});
