import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Texts of the compacted history. Placeholders are replaced in one pass ({{name}}); unknown ones become empty.
// The first line of the summary becomes the new agent's title, so keep {{title}} there.
export const DEFAULT_SUMMARY_HEADER = [
  "{{title}}",
  "",
  "本会话已切换到新的 provider，而它的历史记录超出了新模型的上下文窗口。",
  "较早的历史已压缩在下面：保留了你的消息和助手的文字，每个工具调用压成一行，错误完整保留。",
  "详细记录在 {{transcriptPath}}。每条记录的 [L<first>-L<last>] 指针标明它在该文件中的行范围；需要更多细节时，读取或搜索这些行。过长的工具块可能被截断；图片和推理过程已省略。",
  "不要自行恢复、重复或完成之前的工作。等待用户的下一条消息，只回答那一条。",
  "",
].join("\n");

export const DEFAULT_SUMMARY_ACK =
  "明白。我会使用压缩后的历史；需要细节时再查看完整记录。";

export const DEFAULT_TRANSCRIPT_PROMPT = [
  `你正在接续 agent {{agentId}}（“{{title}}”）的会话，它之前运行在 {{provider}} 上。`,
  "它的完整记录（含工具调用和结果）在 {{path}}。行动之前先读完整个文件，然后从该 agent 停下的地方继续。",
].join("\n");

export const switchSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Compaction: how much of the history is kept and where the target is. All defaults equal the original constants. */
    keepTurns: z.number().int().min(1).max(100).default(10),
    /** Percent of the new model's context window the compacted session may use (room for its own instructions and new work). */
    targetPercent: z.number().int().min(10).max(95).default(60),
    /** Context window assumed when the daemon reports none (tokens). */
    defaultWindowTokens: z.number().int().min(1000).max(10_000_000).default(200_000),
    /** Longest tool call / result kept in the saved transcript (characters). */
    transcriptBlockCap: z.number().int().min(500).max(1_000_000).default(20_000),
    /** Longest file / commit / task list in the summary. */
    listCap: z.number().int().min(5).max(500).default(40),
    /** Timeline entries fetched per request when exporting a transcript, and the longest block kept there. */
    transcriptPage: z.number().int().min(50).max(5000).default(500),
    transcriptMaxBlock: z.number().int().min(500).max(1_000_000).default(20_000),
    /** Texts. Empty = the default. */
    summaryHeader: z.string().default(DEFAULT_SUMMARY_HEADER),
    summaryAck: z.string().default(DEFAULT_SUMMARY_ACK),
    transcriptPrompt: z.string().default(DEFAULT_TRANSCRIPT_PROMPT),
  }),
});

export type SwitchSettings = z.output<typeof switchSettings.schema>;

/** One-pass `{{name}}` replacement; substituted values are never scanned again. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

/** An empty text means "use the default". */
export const textOrDefault = (text: string, fallback: string) => (text.trim() ? text : fallback);
