import { exec, execFile } from "node:child_process";

export interface SelfTestCommand { kind: "typecheck" | "lint" | "test"; command: string }
export type SelfTestResult = SelfTestCommand & { exitCode: number | null; output: string };

export function parseSelfTestCommands(value: unknown): SelfTestCommand[] | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > 12) return undefined;
  const result: SelfTestCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { kind, command } = item as Record<string, unknown>;
    if (!(kind === "typecheck" || kind === "lint" || kind === "test") ||
        typeof command !== "string" || !command.trim() || command.length > 2000) return undefined;
    result.push({ kind, command: command.trim() });
  }
  if (!["typecheck", "lint", "test"].every((kind) => result.some((item) => item.kind === kind)))
    return undefined;
  return result;
}

type Run = (command: string, args: string[] | null, cwd: string) => Promise<{ code: number | null; output: string }>;
const run: Run = (command, args, cwd) => new Promise((resolve) => {
  const options = { cwd, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 };
  const callback = (error: { code?: string | number | null } | null, stdout: string, stderr: string) => {
    let code: number | null = 0;
    if (error) code = typeof error.code === "number" ? error.code : null;
    resolve({ code, output: stdout + stderr });
  };
  if (args) execFile(command, args, options, callback);
  else exec(command, options, callback);
});

export async function matchesVerifiedCommit(cwd: string, commitHash: string, runner: Run = run) {
  const head = await runner("git", ["rev-parse", "HEAD"], cwd);
  const status = await runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  return head.code === 0 && status.code === 0 && head.output.trim() === commitHash && !status.output.trim();
}

/** Capture the real command output against a clean commit. Caller must hold the write barrier. */
export async function collectSelfTest(cwd: string, commands: SelfTestCommand[], runner: Run = run) {
  async function tree() {
    const head = await runner("git", ["rev-parse", "HEAD"], cwd);
    const status = await runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
    if (head.code !== 0 || status.code !== 0 || !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(head.output.trim()))
      throw new Error("无法核对自测提交与工作树");
    return { head: head.output.trim(), status: status.output.trim() };
  }
  const before = await tree();
  if (before.status) throw new Error("自测前工作树不干净");
  const results: SelfTestResult[] = [];
  for (const item of commands) {
    const result = await runner(item.command, null, cwd);
    results.push({ ...item, exitCode: result.code, output: result.output });
  }
  const after = await tree();
  const voided = after.head !== before.head || !!after.status;
  return { commitHash: before.head, results, voided, conclusion: !voided && results.every((r) => r.exitCode === 0) ? "pass" as const : "doubt" as const };
}
