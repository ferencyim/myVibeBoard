import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { TaskArtifact } from "../../shared/vibe/contract";
import { aggregate, fileName, JUDGEMENT_LABELS, SEVERITY_LABELS } from "./evidence";

const judgement = z.enum(["pass", "doubt", "fail"]);
const verification = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      check: z.number().int().positive(),
      judgement,
      note: z.string().default(""),
      evidence: z.array(z.string()).default([]),
    }),
  ),
});
const review = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "issues", "severe"]).optional(),
  issues: z.array(
    z.object({
      severity: z.enum(["severe", "major", "minor"]),
      file: z.string().nullish(),
      line: z.number().int().nullish(),
      text: z.string().min(1),
    }),
  ),
});

export const reportSummarySchema = z.object({
  rawText: z.string(),
  messageId: z.string().optional(),
  title: z.string(),
  conclusion: z.string(),
  summary: z.string(),
  checks: z.array(
    z.object({
      label: z.string(),
      note: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export function summarizeTaskReport(input: {
  item: { text: string; messageId?: string };
  phase: "streaming" | "complete";
  taskConversation?: { conversationId: string; ownerPluginId: string };
}): ReportSummary | undefined {
  if (input.phase !== "complete" || input.taskConversation?.ownerPluginId !== "vibe-board") return;
  return summarizeReport(input.item.text, input.item.messageId);
}

/** A display projection only: original public/provider text remains unchanged and available. */
export function summarizeReport(rawText: string, messageId?: string): ReportSummary | undefined {
  const fences = [...rawText.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (fences.length > 1) return;
  const fence = fences[0];
  let value: unknown;
  try {
    value = JSON.parse(fence?.[1] ?? rawText);
  } catch {
    return;
  }
  const base = { rawText, messageId };
  const verified = verification.safeParse(value);
  if (verified.success) {
    const result = verified.data;
    return {
      ...base,
      title: "模型验证结论",
      conclusion: JUDGEMENT_LABELS[aggregate(result.items.map((item) => item.judgement))],
      summary: result.summary,
      checks: result.items.map((item) => ({
        label: `检查项 ${item.check} · ${JUDGEMENT_LABELS[item.judgement]}`,
        note: item.note,
        evidence: item.evidence,
      })),
    };
  }
  const reviewed = review.safeParse(value);
  if (!reviewed.success) return;
  const result = reviewed.data;
  const severe =
    result.verdict === "severe" || result.issues.some((issue) => issue.severity === "severe");
  let conclusion = "通过";
  if (result.verdict === "issues" || result.issues.length) conclusion = "发现问题";
  if (severe) conclusion = "发现严重问题";
  return {
    ...base,
    title: "模型代码复核结论",
    conclusion,
    summary: result.summary,
    checks: result.issues.map((issue, index) => ({
      label: `问题 ${index + 1} · ${SEVERITY_LABELS[issue.severity]}`,
      note: [
        issue.text,
        issue.file ? `位置：${issue.file}${issue.line ? `:${issue.line}` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      evidence: [],
    })),
  };
}

/** Resolve against this exact historical reply, never the newest run with the same filename. */
export async function findReportEvidence(input: {
  paseo: Pick<PaseoApi, "taskConversations">;
  conversationId: string;
  messageId?: string;
  name: string;
  readArtifacts(workspaceId: string): Promise<TaskArtifact[]>;
}): Promise<string> {
  if (!input.messageId) throw new Error("此报告缺少原始发言定位，请从成员详情查看证据");
  const handle = input.paseo.taskConversations.ref(input.conversationId);
  const conversation = await handle.refresh();
  if (!conversation || conversation.ownerPluginId !== "vibe-board")
    throw new Error("此报告不属于 Vibe 任务会话，请从原会话查看证据");
  let cursor: { epoch: string; seq: number } | undefined;
  for (;;) {
    const result = await handle.fetch({
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 500,
    });
    if (result.error || !result.page) throw new Error(result.error ?? "无法读取报告来源");
    const row = result.page.rows.find((candidate) => candidate.id === input.messageId);
    if (row) {
      const artifacts = await input.readArtifacts(conversation.workspaceId);
      const artifact = artifacts.find(
        (candidate) =>
          candidate.kind === "verification" && candidate.source.sourceKey === row.sourceKey,
      );
      const files = z
        .array(z.object({ id: z.string(), path: z.string() }))
        .safeParse(artifact?.data?.evidence);
      const matches = files.success
        ? files.data.filter(
            (file) => file.path === input.name || fileName(file.path) === input.name,
          )
        : [];
      if (matches.length !== 1)
        throw new Error("此轮证据尚未沉淀、已不存在或名称不唯一，请查看任务面板的验证材料");
      return matches[0]!.id;
    }
    const next = result.page.startCursor;
    if (!result.page.hasOlder || !next || (cursor && next.seq >= cursor.seq))
      throw new Error("找不到此报告的原始发言，无法核对证据所属轮次");
    cursor = next;
  }
}
