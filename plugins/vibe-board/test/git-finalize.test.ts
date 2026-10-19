import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitFinalizer } from "../server/lifecycle/git-finalize";
import { setupBoard, tempDir } from "./helpers";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoWithCard(files: { main?: Record<string, string>; card?: Record<string, string> } = {}) {
  const repo = tempDir("fin-repo-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const wt = join(tempDir("fin-wt-"), "card");
  git(repo, "worktree", "add", "-b", "card-1", wt);
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "t");
  for (const [name, text] of Object.entries(files.card ?? { "feature.txt": "feature\n" })) {
    writeFileSync(join(wt, name), text);
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "feature");
  for (const [name, text] of Object.entries(files.main ?? {})) {
    writeFileSync(join(repo, name), text);
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main change");
  }

  const t = setupBoard();
  const project = t.runtime.store.projects.create({ name: "D", prefix: "DEMO", repoPath: repo });
  const card = t.runtime.store.cards.create({ projectId: project.id, title: "Feature", column: "todo" });
  t.runtime.store.cards.dispatch({
    cardId: card.id,
    agentId: "a1",
    provider: "codex",
    worktree: wt,
  });
  t.runtime.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  t.runtime.store.cards.move(card.id, { to: "done", actor: "user" });
  const finalize = createGitFinalizer({ board: t.board });
  return { t, repo, wt, card: t.runtime.store.cards.get(card.id)!, finalize };
}

const kinds = (t: ReturnType<typeof repoWithCard>["t"], cardId: string) =>
  t.runtime.store.events.list(cardId).map((e) => (e.body as { kind?: string }).kind);

describe("git finalizer", () => {
  it("fast-forwards the branch into main and removes the worktree, keeping the branch", async () => {
    const { repo, wt, card, finalize } = repoWithCard();
    const result = await finalize(card);
    expect(result?.summary).toContain("fast-forward");
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", "card-1")).toContain("card-1");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("makes a normal merge commit when main moved on, never rebases", async () => {
    const { repo, card, finalize } = repoWithCard({ main: { "other.txt": "x\n" } });
    const result = await finalize(card);
    expect(result?.summary).toContain("merge commit");
    expect(git(repo, "log", "--merges", "--oneline")).not.toBe("");
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
  });

  it("stops on a conflict, aborts the merge and reports it on the card", async () => {
    const { t, repo, wt, card, finalize } = repoWithCard({
      card: { "a.txt": "card side\n" },
      main: { "a.txt": "main side\n" },
    });
    expect(await finalize(card)).toBeUndefined();
    expect(kinds(t, card.id)).toContain("finalize_blocked");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "--oneline", "-1")).toContain("main change");
    expect(existsSync(wt)).toBe(true);
  });

  it("refuses a dirty worktree and a dirty main checkout", async () => {
    const dirtyWt = repoWithCard();
    writeFileSync(join(dirtyWt.wt, "wip.txt"), "x");
    expect(await dirtyWt.finalize(dirtyWt.card)).toBeUndefined();
    expect(kinds(dirtyWt.t, dirtyWt.card.id)).toContain("finalize_blocked");
    expect(existsSync(join(dirtyWt.repo, "feature.txt"))).toBe(false);

    const dirtyMain = repoWithCard();
    writeFileSync(join(dirtyMain.repo, "scratch.txt"), "x");
    expect(await dirtyMain.finalize(dirtyMain.card)).toBeUndefined();
    expect(existsSync(join(dirtyMain.repo, "feature.txt"))).toBe(false);
  });

  it("archives the card's worker and verifier agents (not the master) before removing the worktree", async () => {
    const { t, wt, card } = repoWithCard();
    const store = t.runtime.store;
    store.sessions.start({ cardId: card.id, agentId: "v1", workspaceId: null, role: "verifier", provider: "codex" });
    store.sessions.start({ cardId: card.id, agentId: "m1", workspaceId: null, role: "master", provider: "codex" });
    const archived: Array<{ id: string; worktreeThere: boolean }> = [];
    const paseo = {
      agents: {
        ref: (id: string) => ({
          archive: async () => void archived.push({ id, worktreeThere: existsSync(wt) }),
        }),
      },
    } as any;
    const finalize = createGitFinalizer({ board: t.board, getPaseo: () => paseo });
    const result = await finalize(card);
    expect(archived.map((a) => a.id).sort()).toEqual(["a1", "v1"]);
    expect(archived.every((a) => a.worktreeThere)).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(result?.detail).toMatchObject({ worktreeRemoved: true, agentsNotClosed: [] });
  });

  it("reports agents that cannot be shut down in time", async () => {
    const { t, card } = repoWithCard();
    const paseo = { agents: { ref: () => ({ archive: () => new Promise(() => {}) }) } } as any;
    const finalize = createGitFinalizer({ board: t.board, getPaseo: () => paseo, agentCloseTimeoutMs: 20 });
    const result = await finalize(card);
    expect(result?.detail).toMatchObject({ agentsNotClosed: ["a1"] });
  });

  it("does not treat untracked session notes as dirty and removes them before removing the worktree", async () => {
    const { wt, card, finalize } = repoWithCard();
    mkdirSync(join(wt, ".vibe", "sessions"), { recursive: true });
    writeFileSync(join(wt, ".vibe", "sessions", "card.md"), "notes");
    const result = await finalize(card);
    expect(result?.detail).toMatchObject({ worktreeRemoved: true });
    expect(existsSync(wt)).toBe(false);
  });

  it("does nothing for a card without a worktree and honours mode none", async () => {
    const { t, card } = repoWithCard();
    const none = createGitFinalizer({ board: t.board, getConfig: async () => ({ mode: "none" }) });
    expect(await none(card)).toBeUndefined();
    expect(kinds(t, card.id)).toContain("finalize_pending");
    mkdirSync(join(tempDir(), "x"));
    expect(await createGitFinalizer({ board: t.board })({ ...card, worktree: null })).toBeUndefined();
  });
});
