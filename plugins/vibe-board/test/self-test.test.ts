import { describe, expect, it } from "vitest";
import { collectSelfTest, matchesVerifiedCommit, parseSelfTestCommands } from "../server/tabs/self-test";

const commands = [
  { kind: "typecheck", command: "typecheck" },
  { kind: "lint", command: "lint" },
  { kind: "test", command: "test" },
] as const;
const head = "a".repeat(40);

describe("简单流程自测", () => {
  it("必须声明全部三类命令", () => {
    expect(parseSelfTestCommands(commands)).toHaveLength(3);
    expect(parseSelfTestCommands(commands.slice(0, 2))).toBeUndefined();
  });

  it("记录实际命令输出，代码变化时作废", async () => {
    let statusCount = 0;
    const result = await collectSelfTest("worktree", [...commands], async (command, args) => {
      if (command === "git" && args?.[0] === "rev-parse") return { code: 0, output: head };
      if (command === "git") return { code: 0, output: statusCount++ ? " M file" : "" };
      return { code: 0, output: `${command} output` };
    });
    expect(result).toMatchObject({ commitHash: head, conclusion: "doubt", voided: true });
    expect(result.results.map((item) => item.output)).toEqual(["typecheck output", "lint output", "test output"]);
  });

  it("命令失败不得通过", async () => {
    const result = await collectSelfTest("worktree", [...commands], async (command, args) => {
      if (command === "git") return { code: 0, output: args?.[0] === "rev-parse" ? head : "" };
      return { code: command === "lint" ? 1 : 0, output: command };
    });
    expect(result.conclusion).toBe("doubt");
  });

  it("验证后提交或工作树变化不可继续使用证据", async () => {
    const runner = async (_command: string, args: string[] | null) => ({
      code: 0,
      output: args?.[0] === "rev-parse" ? head : " M file",
    });
    expect(await matchesVerifiedCommit("worktree", head, runner)).toBe(false);
    expect(await matchesVerifiedCommit("worktree", "b".repeat(40), runner)).toBe(false);
  });
});
