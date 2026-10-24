import { readFileSync } from "node:fs";
import type { Judgement, VerificationItem } from "../vibe/contract";

/** Head and tail of a small text evidence file (logs, reports); undefined for binary kinds. */
export function textExcerpt(file: string, kind: string, excerptChars: number): string | undefined {
  if (kind !== "log" && kind !== "report") return undefined;
  try {
    const text = readFileSync(file, "utf8");
    return text.length <= excerptChars
      ? text
      : `${text.slice(0, excerptChars / 2)}
...[cut]...
${text.slice(-excerptChars / 2)}`;
  } catch {
    return undefined;
  }
}

const CONCLUSION_ZH: Record<Judgement, string> = {
  pass: "验证通过",
  doubt: "验证存疑",
  fail: "验证未通过",
};

/** 当前任务验证结果的公开摘要。 */
export function verificationLine(
  conclusion: Judgement,
  items: readonly Pick<VerificationItem, "judgement">[],
  commitHash: string,
  voided: boolean,
): string {
  const count = (j: Judgement) => items.filter((i) => i.judgement === j).length;
  const parts = `通过 ${count("pass")} / 存疑 ${count("doubt")} / 失败 ${count("fail")}`;
  return `${CONCLUSION_ZH[conclusion]}（${parts}）· 提交 ${commitHash.slice(0, 8)}${voided ? "，验证 agent 改动了代码，证据作废" : ""}`;
}
