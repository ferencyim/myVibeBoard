import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../contract/model";
import {
  CommandError,
  RequirementsDocError,
  readRequirementsDoc,
  writeRequirementsDoc,
} from "../db";
import { makeTempDir, setup } from "./helpers";

function seed() {
  const s = setup();
  const p = s.store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>" });
  return { s, p };
}

describe("projects: projectTypes / description / requirementsPath", () => {
  it("defaults, and the COMPAT projectType always equals projectTypes[0]", () => {
    const { s, p } = seed();
    expect(p.projectTypes).toEqual(["other"]);
    expect(p.projectType).toBe("other");
    expect(p.description).toBe("");
    expect(p.requirementsPath).toBe("PRODUCT-REQUIREMENTS.md");
    const multi = s.store.projects.update(p.id, { projectTypes: ["web", "android", "web"] });
    expect(multi.projectTypes).toEqual(["web", "android"]);
    expect(multi.projectType).toBe("web");
    // old replica writes only projectType
    const old = s.store.projects.update(p.id, { projectType: "ios" });
    expect(old.projectTypes).toEqual(["ios"]);
    const created = s.store.projects.create({
      name: "X",
      prefix: "XX",
      repoPath: "",
      projectType: "backend",
    });
    expect(created.projectTypes).toEqual(["backend"]);
    expect(() => s.store.projects.update(p.id, { projectTypes: [] })).toThrow(CommandError);
    expect(ProjectSchema.safeParse({ ...multi, projectTypes: ["web", "web"] }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...multi, projectTypes: [] }).success).toBe(false);
  });
});

describe("presets: roleHints", () => {
  it("keeps roleHint as roleHints[0] and maps old single-value writes", () => {
    const { s } = seed();
    const a = s.store.presets.create({ name: "a", provider: "claude", model: "m" });
    expect(a.roleHints).toEqual([]);
    expect(a.roleHint).toBeNull();
    const b = s.store.presets.update(a.id, { roleHints: ["reviewer", "scout", "reviewer"] });
    expect(b.roleHints).toEqual(["reviewer", "scout"]);
    expect(b.roleHint).toBe("reviewer");
    expect(s.store.presets.update(a.id, { roleHint: "worker" }).roleHints).toEqual(["worker"]);
    expect(s.store.presets.update(a.id, { roleHint: null }).roleHints).toEqual([]);
    expect(s.store.presets.update(a.id, { roleHint: "whatever" }).roleHints).toEqual([]);
    expect(() => s.store.presets.update(a.id, { roleHints: ["bogus" as never] })).toThrow(
      CommandError,
    );
    expect(
      s.store.presets.create({ name: "c", provider: "claude", model: "m", roleHint: "scout" })
        .roleHints,
    ).toEqual(["scout"]);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempRepo(): string {
  const dir = makeTempDir("vibe-req-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("requirements-doc", () => {
  it("reads a missing file as empty with exists=false", () => {
    const dir = tempRepo();
    expect(readRequirementsDoc(dir, "PRODUCT-REQUIREMENTS.md")).toEqual({
      path: "PRODUCT-REQUIREMENTS.md",
      exists: false,
      content: "",
    });
  });

  it("creates, commits only that file, keeps LF, and skips no-op writes", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "other.txt"), "staged but unrelated\n");
    git(dir, "add", "other.txt");
    const r = await writeRequirementsDoc(
      dir,
      "docs/REQ.md",
      "a\r\nb\r\n",
      "docs: add requirements",
    );
    expect(r).toMatchObject({ committed: true, created: true, exists: true, path: "docs/REQ.md" });
    expect(readFileSync(join(dir, "docs/REQ.md"), "utf8")).toBe("a\nb\n");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("docs: add requirements");
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("docs/REQ.md");
    expect(git(dir, "status", "--porcelain")).toBe("A  other.txt"); // unrelated staged file untouched
    expect(r.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(readRequirementsDoc(dir, "docs/REQ.md").content).toBe("a\nb\n");

    const same = await writeRequirementsDoc(dir, "docs/REQ.md", "a\nb\n", "noop");
    expect(same).toMatchObject({ committed: false, commit: null, created: false });
    const changed = await writeRequirementsDoc(dir, "docs/REQ.md", "a\nc\n", "docs: edit");
    expect(changed).toMatchObject({ committed: true, created: false });
    expect(git(dir, "log", "--format=%s", "-3")).toBe("docs: edit\ndocs: add requirements\ninit");
  });

  it("rejects traversal and absolute paths", async () => {
    const dir = tempRepo();
    for (const bad of ["../x.md", "a/../../x.md", "/abs.md", "C:\\abs.md", ""]) {
      await expect(writeRequirementsDoc(dir, bad, "x", "m")).rejects.toMatchObject({
        code: "invalid_path",
      });
      expect(() => readRequirementsDoc(dir, bad)).toThrow(RequirementsDocError);
    }
  });

  it("refuses an ignored path", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, ".gitignore"), "ignored.md\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "ignore");
    await expect(writeRequirementsDoc(dir, "ignored.md", "x", "m")).rejects.toMatchObject({
      code: "ignored",
    });
    expect(existsSync(join(dir, "ignored.md"))).toBe(false);
  });

  it("refuses while a merge, rebase or cherry-pick is in progress", async () => {
    const dir = tempRepo();
    const gitDir = join(dir, ".git");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge"]) {
      if (marker === "rebase-merge") mkdirSync(join(gitDir, marker));
      else writeFileSync(join(gitDir, marker), "0000000000000000000000000000000000000000\n");
      await expect(writeRequirementsDoc(dir, "REQ.md", "x", "m")).rejects.toMatchObject({
        code: "repo_busy",
      });
      expect(existsSync(join(dir, "REQ.md"))).toBe(false);
      if (marker !== "rebase-merge") (await import("node:fs")).unlinkSync(join(gitDir, marker));
    }
  });

  it("uses an injected runner (no real git)", async () => {
    const dir = makeTempDir("vibe-req-fake-");
    mkdirSync(join(dir, ".git"));
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "ls-files") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "A  REQ.md\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await writeRequirementsDoc(dir, "REQ.md", "x", "msg", runner);
    expect(r.commit).toBe("abc123");
    expect(calls.map((c) => c[0])).toEqual([
      "rev-parse",
      "check-ignore",
      "ls-files",
      "add",
      "status",
      "commit",
      "rev-parse",
    ]);
    expect(calls.find((c) => c[0] === "commit")).toEqual(["commit", "-m", "msg", "--", "REQ.md"]);
  });
});
