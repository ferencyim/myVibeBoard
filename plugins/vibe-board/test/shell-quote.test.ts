import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { attachmentGetCommand } from "../shared/constants";

const hasSh = (() => {
  try {
    execFileSync("sh", ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSh)("attachmentGetCommand", () => {
  it.each([
    "report.txt",
    "my report.txt",
    "report $(id).txt",
    "a`id`;b|c&d>e.txt",
    "it's \"quoted\".txt",
  ])("passes %s to the shell as one literal --out argument", (fileName) => {
    const command = attachmentGetCommand("att_1", fileName).replace(
      /^paseo-tasks /,
      "printf '%s\\n' ",
    );
    const args = execFileSync("sh", ["-c", command], { encoding: "utf8" })
      .trimEnd()
      .split("\n");
    expect(args).toEqual(["attachment", "get", "att_1", "--out", `./${fileName}`]);
  });
});
